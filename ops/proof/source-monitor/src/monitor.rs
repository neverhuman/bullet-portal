use super::common::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CString;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(super) struct Entry {
    pub(super) kind: &'static str,
    dev: u64,
    ino: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    links: Option<u64>,
    length: Option<u64>,
    mtime: Option<(i64, i64)>,
    ctime: Option<(i64, i64)>,
    content_sha256: Option<String>,
    pub(super) link_target: Option<String>,
}

pub(super) fn entry(path: &Path) -> Result<Entry> {
    let m = io(fs::symlink_metadata(path))?;
    let (kind, content_sha256, link_target) = if m.is_file() {
        // O_NOFOLLOW prevents a replaced input symlink from redirecting the read.
        let mut f = io(OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path))?;
        let opened = io(f.metadata())?;
        if (m.dev(), m.ino()) != (opened.dev(), opened.ino()) {
            return Err("INPUT_REPLACED".into());
        }
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 65536];
        loop {
            let n = io(f.read(&mut buffer))?;
            if n == 0 {
                break;
            }
            digest.update(&buffer[..n]);
        }
        ("file", Some(format!("{:x}", digest.finalize())), None)
    } else if m.is_dir() {
        ("directory", None, None)
    } else if m.file_type().is_symlink() {
        ("symlink", None, Some(name(&io(fs::read_link(path))?)?))
    } else {
        return Err(format!("SPECIAL_INPUT_REFUSED: {}", path.display()));
    };
    let directory = m.is_dir();
    Ok(Entry {
        kind,
        dev: m.dev(),
        ino: m.ino(),
        mode: m.mode(),
        uid: m.uid(),
        gid: m.gid(),
        // Directory times/link counts change when an admitted output is created.
        links: (!directory).then(|| m.nlink()),
        length: (!directory).then_some(m.len()),
        mtime: (!directory).then(|| (m.mtime(), m.mtime_nsec())),
        ctime: (!directory).then(|| (m.ctime(), m.ctime_nsec())),
        content_sha256,
        link_target,
    })
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub(super) enum Scope {
    Node(PathBuf),
    Identity(PathBuf),
    Children(PathBuf),
    Ancestor { path: PathBuf, child: PathBuf },
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Snapshot {
    pub(super) entries: BTreeMap<String, Entry>,
    pub(super) lookups: BTreeMap<String, super::lookup::Observation>,
}

pub(super) struct Monitor {
    pub(super) fd: OwnedFd,
    pub(super) scopes: BTreeMap<i32, BTreeSet<Scope>>,
    pub(super) roots: BTreeSet<PathBuf>,
    pub(super) lookups: Vec<Lookup>,
    declared_targets: BTreeMap<PathBuf, PathBuf>,
    pub(super) exclude: Vec<PathBuf>,
    pub(super) failure: Option<String>,
}

impl Monitor {
    pub(super) fn new(exclude: Vec<PathBuf>) -> Result<Self> {
        // SAFETY: no pointers; the returned owned descriptor is checked once.
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if fd < 0 {
            return Err(format!("WATCH_INIT: {}", std::io::Error::last_os_error()));
        }
        Ok(Self {
            // SAFETY: successful inotify_init1 returns a fresh descriptor.
            fd: unsafe { OwnedFd::from_raw_fd(fd) },
            scopes: BTreeMap::new(),
            roots: BTreeSet::new(),
            lookups: Vec::new(),
            declared_targets: BTreeMap::new(),
            exclude,
            failure: None,
        })
    }
    pub(super) fn excluded(&self, path: &Path) -> bool {
        self.exclude.iter().any(|e| path.starts_with(e))
    }
    pub(super) fn add(&mut self, path: &Path, scope: Scope) -> Result<()> {
        let cpath = CString::new(path.as_os_str().as_bytes()).map_err(|_| "NUL_PATH")?;
        // SAFETY: cpath lives through the call; fd is owned and valid.
        let wd = unsafe {
            libc::inotify_add_watch(
                self.fd.as_raw_fd(),
                cpath.as_ptr(),
                MASK | libc::IN_DONT_FOLLOW | libc::IN_MASK_ADD,
            )
        };
        if wd < 0 {
            return Err(format!(
                "WATCH_ADD {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        self.scopes.entry(wd).or_default().insert(scope);
        Ok(())
    }
    pub(super) fn ancestors(&mut self, path: &Path) -> Result<()> {
        let mut child = path.to_owned();
        while let Some(parent) = child.parent() {
            if io(fs::symlink_metadata(parent))?.file_type().is_symlink() {
                return Err("SYMLINKED_INPUT_ANCESTOR_REFUSED".into());
            }
            self.add(
                parent,
                Scope::Ancestor {
                    path: parent.to_owned(),
                    child: child.clone(),
                },
            )?;
            child = parent.to_owned();
        }
        Ok(())
    }
    pub(super) fn install_inputs(&mut self, lookups: &[Lookup]) -> Result<()> {
        self.declared_targets.clear();
        // Only successfully validated, watched lookups may opt a recursive
        // symlink into the explicit chain resolver. No path is inferred here.
        self.install_lookups(lookups)?;
        self.declared_targets = lookups
            .iter()
            .filter(|lookup| lookup.kind != LookupKind::Absent)
            .filter_map(|lookup| {
                lookup
                    .target
                    .clone()
                    .map(|target| (lookup.path.clone(), target))
            })
            .collect();
        let mut visited = BTreeSet::new();
        for root in self.roots.clone() {
            absolute(&root)?;
            self.ancestors(&root)?;
            self.install(&root, &mut visited)?;
        }
        self.drain()
    }
    pub(super) fn install(&mut self, path: &Path, visited: &mut BTreeSet<PathBuf>) -> Result<()> {
        if self.excluded(path) || !visited.insert(path.to_owned()) {
            return Ok(());
        }
        let m = io(fs::symlink_metadata(path))?;
        let scope = if m.is_dir() {
            Scope::Children(path.to_owned())
        } else {
            Scope::Node(path.to_owned())
        };
        self.add(path, scope)?;
        if m.is_dir() {
            for child in children(path)? {
                self.install(&child, visited)?;
            }
        } else if m.file_type().is_symlink() {
            let target = if let Some(declared) = self.declared_targets.get(path) {
                let target = io(fs::canonicalize(path))?;
                if &target != declared {
                    return Err("LOOKUP_TARGET_DIFFERS_FROM_ADMISSION".into());
                }
                target
            } else {
                let link = io(fs::read_link(path))?;
                let raw_target = if link.is_absolute() {
                    link
                } else {
                    path.parent().ok_or("SYMLINK_PARENT_MISSING")?.join(link)
                };
                // Resolve dot components lexically, then require the resolution chain
                // to contain no further symlinks. Canonicalize alone would hide them.
                let mut target_path = PathBuf::new();
                for component in raw_target.components() {
                    match component {
                        std::path::Component::ParentDir => {
                            target_path.pop();
                        }
                        std::path::Component::CurDir => (),
                        other => target_path.push(other),
                    }
                }
                if io(fs::canonicalize(&target_path))? != target_path {
                    return Err("INDIRECT_SYMLINK_INPUT_REFUSED".into());
                }
                let target = io(fs::canonicalize(path))?;
                if target != target_path {
                    return Err("INDIRECT_SYMLINK_INPUT_REFUSED".into());
                }
                target
            };
            if self.excluded(&target) {
                return Err("INPUT_SYMLINK_POINTS_TO_EXCLUDED_OUTPUT".into());
            }
            self.roots.insert(target.clone());
            self.ancestors(&target)?;
            self.install(&target, visited)?;
        } else if !m.is_file() {
            return Err("SPECIAL_INPUT_REFUSED".into());
        }
        Ok(())
    }
    pub(super) fn latch(&mut self, reason: String) {
        if self.failure.is_none() {
            self.failure = Some(reason);
        }
    }
    pub(super) fn event(&mut self, wd: i32, mask: u32, child: Option<&str>) {
        if mask & LOSS != 0 {
            self.latch(format!("WATCH_LOST: mask={mask:#x}"));
            return;
        }
        if mask == 0 || mask & !(MASK | libc::IN_ISDIR) != 0 {
            self.latch("MALFORMED_EVENT_MASK".into());
            return;
        }
        let Some(scopes) = self.scopes.get(&wd) else {
            self.latch("UNKNOWN_WATCH".into());
            return;
        };
        let mut changed = None;
        for scope in scopes {
            let path = match scope {
                Scope::Identity(path) => child.is_none().then(|| path.clone()),
                Scope::Node(path) => {
                    if child.is_some() {
                        changed = Some("MALFORMED_NODE_EVENT".into());
                        break;
                    }
                    Some(path.clone())
                }
                Scope::Children(path) => Some(child.map_or_else(|| path.clone(), |c| path.join(c))),
                Scope::Ancestor {
                    path,
                    child: selected,
                } => match child {
                    None => Some(path.clone()),
                    Some(c) if path.join(c) == *selected => Some(selected.clone()),
                    _ => None,
                },
            };
            if let Some(path) = path.filter(|p| !self.excluded(p)) {
                changed = Some(format!(
                    "SOURCE_MUTATION: {} mask={mask:#x}",
                    path.display()
                ));
                break;
            }
        }
        if let Some(reason) = changed {
            self.latch(reason);
        }
    }
    pub(super) fn parse(&mut self, bytes: &[u8]) -> Result<()> {
        let mut cursor = 0;
        while cursor < bytes.len() {
            let h = bytes
                .get(cursor..cursor + 16)
                .ok_or("MALFORMED_EVENT_HEADER")?;
            let wd = i32::from_ne_bytes(h[..4].try_into().unwrap());
            let mask = u32::from_ne_bytes(h[4..8].try_into().unwrap());
            let length = u32::from_ne_bytes(h[12..16].try_into().unwrap()) as usize;
            cursor += 16;
            let raw = bytes
                .get(cursor..cursor + length)
                .ok_or("MALFORMED_EVENT_LENGTH")?;
            let child = if raw.is_empty() {
                None
            } else {
                let end = raw
                    .iter()
                    .position(|b| *b == 0)
                    .ok_or("MALFORMED_EVENT_NAME")?;
                if end == 0 || raw[end..].iter().any(|b| *b != 0) {
                    return Err("MALFORMED_EVENT_PADDING".into());
                }
                let child = std::str::from_utf8(&raw[..end]).map_err(|_| "NON_UTF8_EVENT")?;
                if child.contains('/') || matches!(child, "." | "..") {
                    return Err("MALFORMED_EVENT_NAME".into());
                }
                Some(child)
            };
            self.event(wd, mask, child);
            cursor += length;
        }
        Ok(())
    }
    pub(super) fn drain(&mut self) -> Result<()> {
        let mut buffer = [0_u8; 65536];
        loop {
            // SAFETY: buffer is writable for its full length, fd is live.
            let n = unsafe {
                libc::read(
                    self.fd.as_raw_fd(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                )
            };
            if n < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::WouldBlock {
                    break;
                }
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                self.latch(format!("WATCH_READ: {error}"));
                break;
            }
            if n == 0 {
                self.latch("WATCH_EOF".into());
                break;
            }
            if let Err(error) = self.parse(&buffer[..n as usize]) {
                self.latch(error);
            }
        }
        self.healthy()
    }
    pub(super) fn healthy(&self) -> Result<()> {
        self.failure
            .as_ref()
            .map_or(Ok(()), |error| Err(error.clone()))
    }
    pub(super) fn snapshot(&self) -> Result<Snapshot> {
        fn walk(
            m: &Monitor,
            path: &Path,
            all: &mut BTreeMap<String, Entry>,
            visited: &mut BTreeSet<PathBuf>,
        ) -> Result<()> {
            if m.excluded(path) || !visited.insert(path.to_owned()) {
                return Ok(());
            }
            let value = entry(path)?;
            let directory = value.kind == "directory";
            all.insert(name(path)?, value);
            if directory {
                for child in children(path)? {
                    walk(m, &child, all, visited)?;
                }
            }
            Ok(())
        }
        let mut all = BTreeMap::new();
        let mut visited = BTreeSet::new();
        for root in &self.roots {
            walk(self, root, &mut all, &mut visited)?;
            for parent in root.ancestors().skip(1) {
                all.entry(name(parent)?).or_insert(entry(parent)?);
            }
        }
        Ok(Snapshot {
            entries: all,
            lookups: self.lookup_snapshot()?,
        })
    }
    pub(super) fn checkpoint(&mut self, baseline: &Snapshot) -> Result<()> {
        self.drain()?;
        let observed = self.snapshot()?;
        self.drain()?;
        if &observed != baseline {
            self.latch("INPUT_INVENTORY_CHANGED".into());
        }
        self.healthy()
    }
}
