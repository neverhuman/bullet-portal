use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};

pub(super) type Result<T> = std::result::Result<T, String>;
pub(super) const MASK: u32 = libc::IN_MODIFY
    | libc::IN_ATTRIB
    | libc::IN_CLOSE_WRITE
    | libc::IN_MOVED_FROM
    | libc::IN_MOVED_TO
    | libc::IN_CREATE
    | libc::IN_DELETE
    | libc::IN_DELETE_SELF
    | libc::IN_MOVE_SELF
    | libc::IN_UNMOUNT;
pub(super) const LOSS: u32 = libc::IN_Q_OVERFLOW | libc::IN_IGNORED | libc::IN_UNMOUNT;

pub(super) fn io<T>(result: std::io::Result<T>) -> Result<T> {
    result.map_err(|e| e.to_string())
}
pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn json<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|e| e.to_string())
}
pub(super) fn name(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "NON_UTF8_PATH".into())
}
pub(super) fn absolute(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("PATH_MUST_BE_ABSOLUTE_NORMALIZED".into());
    }
    Ok(())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Config {
    pub(super) schema: String,
    pub(super) nonce: String,
    pub(super) owner_pid: u32,
    pub(super) owner_record: PathBuf,
    pub(super) roots: Vec<PathBuf>,
    // Omitted by legacy configurations: canonical recursive roots only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) lookups: Vec<Lookup>,
    pub(super) exclude: Vec<PathBuf>,
    pub(super) inventory_path: PathBuf,
    pub(super) max_seconds: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum LookupKind {
    File,
    Directory,
    Absent,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Lookup {
    pub(super) path: PathBuf,
    pub(super) kind: LookupKind,
    pub(super) target: Option<PathBuf>,
}

pub(super) fn children(path: &Path) -> Result<Vec<PathBuf>> {
    let mut children: Vec<_> = io(fs::read_dir(path))?
        .map(|r| r.map(|e| e.path()))
        .collect::<std::io::Result<_>>()
        .map_err(|e| e.to_string())?;
    children.sort();
    Ok(children)
}
pub(super) fn process_start(pid: u32) -> Result<String> {
    let stat = io(fs::read_to_string(format!("/proc/{pid}/stat")))?;
    let fields: Vec<_> = stat
        .rsplit_once(") ")
        .ok_or("PROCESS_STAT_MALFORMED")?
        .1
        .split_whitespace()
        .collect();
    if matches!(fields.first(), Some(&"Z" | &"X")) {
        return Err("OWNER_NOT_LIVE".into());
    }
    fields
        .get(19)
        .map(|s| (*s).to_owned())
        .ok_or_else(|| "PROCESS_START_MISSING".into())
}
