use super::common::*;
use super::monitor::{Entry, Monitor, Scope};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    command: String,
    nonce: String,
    subject: String,
    sequence: u64,
}
#[derive(Serialize)]
struct Inventory<'a> {
    schema: &'static str,
    config: &'a Config,
    roots: &'a BTreeSet<PathBuf>,
    entries: &'a BTreeMap<String, Entry>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    lookups: &'a BTreeMap<String, super::lookup::Observation>,
    watch_scopes: BTreeSet<&'a Scope>,
}
#[derive(Serialize)]
struct Ack<'a> {
    schema: &'static str,
    command: &'a str,
    nonce: &'a str,
    subject: &'a str,
    sequence: u64,
    monitor_pid: u32,
    monitor_start: &'a str,
    owner_pid: u32,
    owner_start: &'a str,
    watch_sha256: &'a str,
    entry_count: usize,
}
fn acknowledge(ack: &Ack<'_>) -> Result<()> {
    let mut stdout = std::io::stdout().lock();
    io(stdout.write_all(&json(ack)?))?;
    io(stdout.write_all(b"\n"))?;
    io(stdout.flush())
}

pub fn run() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let config_path = PathBuf::from(
        args.next()
            .ok_or("USAGE: bullet-proof-source-monitor CONFIG.json")?,
    );
    if args.next().is_some() {
        return Err("UNEXPECTED_ARGUMENT".into());
    }
    absolute(&config_path)?;
    let config_bytes = io(fs::read(&config_path))?;
    let config: Config =
        serde_json::from_slice(&config_bytes).map_err(|e| format!("CONFIG: {e}"))?;
    if config.schema != "bullet.source-monitor.config.v1"
        || config.roots.is_empty()
        || !(1..=86400).contains(&config.max_seconds)
        || !(32..=128).contains(&config.nonce.len())
        || !config
            .nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("CONFIG_INVALID".into());
    }
    // SAFETY: these calls take no pointers and cannot alter process state.
    if config.owner_pid != unsafe { libc::getppid() } as u32 {
        return Err("OWNER_IS_NOT_PARENT".into());
    }
    let owner_start = process_start(config.owner_pid)?;
    let monitor_start = process_start(std::process::id())?;
    absolute(&config.owner_record)?;
    absolute(&config.inventory_path)?;
    let owner = io(fs::symlink_metadata(&config.owner_record))?;
    // Wrapper remains responsible for verifying the record's authority semantics.
    if !owner.is_file()
        || owner.mode() & 0o777 != 0o600
        || owner.nlink() != 1
        || owner.uid() != unsafe { libc::geteuid() }
    {
        return Err("OWNER_RECORD_CUSTODY".into());
    }
    let executable = io(std::env::current_exe())?;
    let mut monitor = Monitor::new(config.exclude.clone())?;
    let mandatory = [config_path.clone(), config.owner_record.clone(), executable];
    for path in config.roots.iter().chain(&config.exclude).chain(&mandatory) {
        absolute(path)?;
    }
    for excluded in &config.exclude {
        if !config
            .roots
            .iter()
            .any(|r| excluded.starts_with(r) && excluded != r)
            || mandatory.iter().any(|p| p.starts_with(excluded))
        {
            return Err("EXCLUSION_NOT_A_REVIEWABLE_OUTPUT_SUBTREE".into());
        }
    }
    monitor
        .roots
        .extend(config.roots.iter().chain(&mandatory).cloned());
    if monitor
        .roots
        .iter()
        .any(|r| config.inventory_path.starts_with(r))
        && !monitor.excluded(&config.inventory_path)
    {
        return Err("INVENTORY_OUTPUT_INSIDE_INPUTS".into());
    }
    monitor.install_inputs(&config.lookups)?;
    let baseline = monitor.snapshot()?;
    monitor.drain()?;
    if io(fs::read(&config_path))? != config_bytes {
        return Err("CONFIG_CHANGED_DURING_STARTUP".into());
    }
    let watch_scopes: BTreeSet<_> = monitor.scopes.values().flatten().collect();
    let watch_sha256 = hash(&json(&watch_scopes)?);
    let inventory = json(&Inventory {
        schema: "bullet.source-monitor.inventory.v1",
        config: &config,
        roots: &monitor.roots,
        entries: &baseline.entries,
        lookups: &baseline.lookups,
        watch_scopes,
    })?;
    let subject = hash(&inventory);
    let mut output = io(OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&config.inventory_path))?;
    io(output.write_all(&inventory))?;
    io(output.sync_all())?;
    monitor.drain()?;
    let mut ack = Ack {
        schema: "bullet.source-monitor.ack.v1",
        command: "READY",
        nonce: &config.nonce,
        subject: &subject,
        sequence: 0,
        monitor_pid: std::process::id(),
        monitor_start: &monitor_start,
        owner_pid: config.owner_pid,
        owner_start: &owner_start,
        watch_sha256: &watch_sha256,
        entry_count: baseline.entries.len() + baseline.lookups.len(),
    };
    acknowledge(&ack)?;
    let start = Instant::now();
    let mut input = Vec::new();
    loop {
        if start.elapsed() > Duration::from_secs(config.max_seconds) {
            return Err("MONITOR_DEADLINE".into());
        }
        if process_start(config.owner_pid)? != owner_start {
            return Err("OWNER_IDENTITY_CHANGED".into());
        }
        let mut pollfds = [
            libc::pollfd {
                fd: monitor.fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: libc::STDIN_FILENO,
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // SAFETY: both descriptors and the pollfd array remain live during poll.
        let count = unsafe { libc::poll(pollfds.as_mut_ptr(), pollfds.len() as libc::nfds_t, 100) };
        if count < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err("CONTROL_POLL_FAILED".into());
        }
        monitor.drain()?;
        if pollfds
            .iter()
            .any(|p| p.revents & (libc::POLLERR | libc::POLLNVAL) != 0)
        {
            return Err("CONTROL_LOST".into());
        }
        if pollfds[1].revents & (libc::POLLIN | libc::POLLHUP) == 0 {
            continue;
        }
        let mut buffer = [0_u8; 4096];
        // SAFETY: buffer is writable; stdin is the wrapper-owned control pipe.
        let n = unsafe { libc::read(libc::STDIN_FILENO, buffer.as_mut_ptr().cast(), buffer.len()) };
        if n <= 0 {
            return Err("CONTROL_EOF_OR_READ_FAILURE".into());
        }
        input.extend_from_slice(&buffer[..n as usize]);
        if input.len() > 4096 {
            return Err("CONTROL_TOO_LARGE".into());
        }
        while let Some(end) = input.iter().position(|b| *b == b'\n') {
            let request: Request =
                serde_json::from_slice(&input[..end]).map_err(|_| "CONTROL_MALFORMED")?;
            input.drain(..=end);
            if request.nonce != config.nonce
                || request.subject != subject
                || request.sequence != ack.sequence + 1
            {
                return Err("CONTROL_SUBJECT_OR_SEQUENCE_MISMATCH".into());
            }
            if !matches!(request.command.as_str(), "CHECK" | "FINISH") {
                return Err("CONTROL_COMMAND_UNKNOWN".into());
            }
            monitor.checkpoint(&baseline)?;
            if process_start(config.owner_pid)? != owner_start {
                return Err("OWNER_IDENTITY_CHANGED".into());
            }
            monitor.drain()?;
            ack.sequence = request.sequence;
            ack.command = if request.command == "FINISH" {
                "FINISHED"
            } else {
                "CHECKED"
            };
            acknowledge(&ack)?;
            if request.command == "FINISH" {
                if !input.is_empty() {
                    return Err("CONTROL_AFTER_FINISH".into());
                }
                return Ok(());
            }
        }
    }
}
