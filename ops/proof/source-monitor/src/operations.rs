//! Finite Linux operations. External callers impose their own response deadlines.
use super::common::*;
use super::monitor::{Monitor, Scope};
use serde_json::{Value, json as value};
use std::collections::BTreeSet;
use std::fs;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};

pub(super) fn verify_inventory(path: &Path) -> Result<Value> {
    absolute(path)?;
    let original = io(fs::read(path))?;
    let inventory: Value = serde_json::from_slice(&original).map_err(|e| e.to_string())?;
    if inventory["schema"] != "bullet.source-monitor.inventory.v1" {
        return Err("INVENTORY_SCHEMA".into());
    }
    let config: Config =
        serde_json::from_value(inventory["config"].clone()).map_err(|e| e.to_string())?;
    let ephemeral = config.owner_record.parent().ok_or("OWNER_PARENT")?;
    let git = ephemeral.parent().ok_or("GIT_PARENT")?;
    let checkout = git.parent().ok_or("CHECKOUT_PARENT")?;
    // Only this reserved wrapper-owned lock tree is temporary. Git index, refs,
    // configuration, ignored dependencies and every external input stay bound.
    if config.owner_record.file_name().and_then(|p| p.to_str()) != Some("owner")
        || ephemeral.file_name().and_then(|p| p.to_str()) != Some("bullet-ci.lock.d")
        || git.file_name().and_then(|p| p.to_str()) != Some(".git")
        || !config.roots.contains(&checkout.to_owned())
    {
        return Err("EPHEMERAL_CUSTODY_CLASSIFICATION".into());
    }
    let mut inventory_guard = Monitor::new(vec![])?;
    inventory_guard.ancestors(path)?;
    inventory_guard.add(path, Scope::Node(path.to_owned()))?;
    if io(fs::read(path))? != original {
        return Err("INVENTORY_CHANGED".into());
    }
    let mut exclusions = config.exclude;
    exclusions.push(ephemeral.to_owned());
    let mut monitor = Monitor::new(exclusions)?;
    let roots: BTreeSet<PathBuf> =
        serde_json::from_value(inventory["roots"].clone()).map_err(|e| e.to_string())?;
    monitor.roots = roots
        .into_iter()
        .filter(|p| !p.starts_with(ephemeral))
        .collect();
    monitor.install_inputs(&config.lookups)?;
    let mut expected = inventory["entries"]
        .as_object()
        .ok_or("INVENTORY_ENTRIES")?
        .clone();
    expected.retain(|p, _| !Path::new(p).starts_with(ephemeral));
    let snapshot = monitor.snapshot()?;
    let observed = serde_json::to_value(&snapshot.entries).map_err(|e| e.to_string())?;
    let lookups = serde_json::to_value(&snapshot.lookups).map_err(|e| e.to_string())?;
    monitor.drain()?;
    inventory_guard.drain()?;
    if observed != Value::Object(expected) {
        return Err("CURRENT_INPUT_INVENTORY_CHANGED".into());
    }
    let expected_lookups = inventory
        .get("lookups")
        .cloned()
        .unwrap_or_else(|| value!({}));
    if lookups != expected_lookups {
        return Err("CURRENT_LOOKUP_INVENTORY_CHANGED".into());
    }
    Ok(value!({"schema":"bullet.source-monitor.revalidation.v1",
        "inventory_sha256":hash(&original), "outcome":"MATCH"}))
}

pub(super) fn terminate(pid: u32, expected: &str, owner: u32) -> Result<Value> {
    if pid < 2 || owner < 2 {
        return Err("TERMINATION_IDENTITY".into());
    }
    let ack = |outcome: &str| {
        value!({"schema":"bullet.source-monitor.termination.v1",
        "pid":pid,"expected_start":expected,"owner_pid":owner,"outcome":outcome})
    };
    // SAFETY: pidfd_open has no pointers; it binds the selected process lifetime.
    let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0_u32) };
    if raw < 0 {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(ack("ORIGINAL_GONE"))
        } else {
            Err(format!("PIDFD_OPEN: {error}"))
        };
    }
    // SAFETY: successful pidfd_open returned a fresh owned descriptor.
    let fd = unsafe { OwnedFd::from_raw_fd(raw as i32) };
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ack("ORIGINAL_GONE"));
        }
        Err(error) => return Err(format!("TERMINATION_STAT: {error}")),
    };
    let fields: Vec<_> = stat
        .rsplit_once(") ")
        .ok_or("PROCESS_STAT_MALFORMED")?
        .1
        .split_whitespace()
        .collect();
    let actual = fields.get(19).ok_or("PROCESS_START_MISSING")?;
    if expected.is_empty() || !expected.bytes().all(|b| b.is_ascii_digit()) {
        return Err("TERMINATION_START_UNAVAILABLE".into());
    }
    if *actual != expected {
        return Ok(ack("IDENTITY_CHANGED_NOT_SIGNALED"));
    }
    if fields.get(1).and_then(|p| p.parse::<u32>().ok()) != Some(owner) {
        return Err("TERMINATION_OWNER_CHANGED".into());
    }
    // A reused numeric PID cannot redirect this signal: only the acquired pidfd
    // receives it. Identity was checked after acquisition and before signaling.
    // SAFETY: null siginfo is documented for pidfd_send_signal with flags zero.
    let sent = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            fd.as_raw_fd(),
            libc::SIGKILL,
            std::ptr::null::<libc::siginfo_t>(),
            0_u32,
        )
    };
    if sent < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
        return Err(format!("PIDFD_SIGNAL: {}", std::io::Error::last_os_error()));
    }
    let mut poll = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: the single live pollfd remains valid throughout the bounded wait.
    let result = unsafe { libc::poll(&mut poll, 1, 2000) };
    if result <= 0
        || poll.revents & (libc::POLLIN | libc::POLLHUP) == 0
        || poll.revents & (libc::POLLERR | libc::POLLNVAL) != 0
    {
        return Err("TERMINATION_NOT_OBSERVED".into());
    }
    Ok(ack("TERMINATED"))
}

pub(super) fn run() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let result = if args.first().is_some_and(|a| a == "--verify-inventory") && args.len() == 2 {
        verify_inventory(Path::new(&args[1]))?
    } else if args.first().is_some_and(|a| a == "--terminate-monitor") && args.len() == 4 {
        let parse = |i: usize| {
            args[i]
                .to_str()
                .ok_or("ARGUMENT_UTF8")?
                .parse::<u32>()
                .map_err(|_| "ARGUMENT_PID")
        };
        terminate(
            parse(1)?,
            args[2].to_str().ok_or("ARGUMENT_UTF8")?,
            parse(3)?,
        )?
    } else {
        return super::protocol::run();
    };
    println!("{result}");
    Ok(())
}
