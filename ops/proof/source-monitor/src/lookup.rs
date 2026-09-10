//! Exact lookup paths are separate from canonical recursive source roots.
//! Each lexical alias and the first absent component remains an input subject.
use super::common::*;
use super::monitor::{Entry, Monitor, Scope, entry};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(super) struct Observation {
    kind: LookupKind,
    target: Option<PathBuf>,
    missing_component: Option<PathBuf>,
    components: BTreeMap<String, Option<Entry>>,
}

fn tokens(path: &Path) -> Result<VecDeque<String>> {
    let text = name(path)?;
    if text.is_empty() || text.contains('\0') {
        return Err("LOOKUP_EMPTY_OR_NUL".into());
    }
    // Preserve '..' until its preceding symlinks have actually been resolved.
    // A trailing slash requires a directory, even at the end of a symlink.
    let mut result: VecDeque<_> = text
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    if text.ends_with('/') {
        result.push_back(".".into());
    }
    Ok(result)
}

fn permitted(path: &Path, exclude: &[PathBuf]) -> Result<()> {
    if exclude.iter().any(|p| path.starts_with(p)) {
        return Err("LOOKUP_INTERSECTS_EXCLUDED_OUTPUT".into());
    }
    Ok(())
}

fn resolve(
    lookup: &Lookup,
    exclude: &[PathBuf],
    mut watch: impl FnMut(&Path, Scope) -> Result<()>,
) -> Result<Observation> {
    absolute(&lookup.path)?;
    let normalized: PathBuf = lookup.path.components().collect();
    if normalized.as_os_str() != lookup.path.as_os_str() {
        return Err("LOOKUP_PATH_NOT_NORMALIZED".into());
    }
    if let Some(target) = &lookup.target {
        absolute(target)?;
        permitted(target, exclude)?;
    }
    if (lookup.kind == LookupKind::Absent) != lookup.target.is_none() {
        return Err("LOOKUP_DECLARATION_KIND".into());
    }
    permitted(&lookup.path, exclude)?;
    let mut pending = tokens(&lookup.path)?;
    let mut current = PathBuf::from("/");
    let mut components = BTreeMap::new();
    let mut symlinks = 0;
    watch(&current, Scope::Identity(current.clone()))?;
    components.insert(name(&current)?, Some(entry(&current)?));
    while let Some(component) = pending.pop_front() {
        // The current path was fully resolved and observed as a directory.
        if component == "." {
            continue;
        }
        if component == ".." {
            current.pop();
            if current.as_os_str().is_empty() {
                current.push("/");
            }
            continue;
        }
        let candidate = current.join(component);
        permitted(&candidate, exclude)?;
        watch(
            &current,
            Scope::Ancestor {
                path: current.clone(),
                child: candidate.clone(),
            },
        )?;
        let metadata = match fs::symlink_metadata(&candidate) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                components.insert(name(&candidate)?, None);
                if lookup.kind != LookupKind::Absent {
                    return Err("LOOKUP_EXPECTED_TARGET_ABSENT".into());
                }
                return Ok(Observation {
                    kind: LookupKind::Absent,
                    target: None,
                    missing_component: Some(candidate),
                    components,
                });
            }
            Err(error) => return Err(format!("LOOKUP_METADATA: {error}")),
        };
        let scope = if metadata.is_dir() {
            Scope::Identity(candidate.clone())
        } else {
            Scope::Node(candidate.clone())
        };
        watch(&candidate, scope)?;
        let observed = entry(&candidate)?;
        if metadata.file_type().is_symlink() {
            if observed.kind != "symlink" {
                return Err("LOOKUP_REPLACED_DURING_RESOLUTION".into());
            }
            symlinks += 1;
            if symlinks > 40 {
                return Err("LOOKUP_SYMLINK_CYCLE_OR_LIMIT".into());
            }
            let target = PathBuf::from(observed.link_target.as_ref().ok_or("LOOKUP_LINK_TEXT")?);
            let mut expanded = tokens(&target)?;
            expanded.append(&mut pending);
            pending = expanded;
            if target.is_absolute() {
                current = PathBuf::from("/");
            }
            components.insert(name(&candidate)?, Some(observed));
            continue;
        }
        let kind = if metadata.is_dir() {
            LookupKind::Directory
        } else if metadata.is_file() {
            LookupKind::File
        } else {
            return Err("LOOKUP_UNSUPPORTED_KIND".into());
        };
        if observed.kind
            != if kind == LookupKind::Directory {
                "directory"
            } else {
                "file"
            }
        {
            return Err("LOOKUP_REPLACED_DURING_RESOLUTION".into());
        }
        components.insert(name(&candidate)?, Some(observed));
        if !pending.is_empty() && kind != LookupKind::Directory {
            return Err("LOOKUP_NON_DIRECTORY_ANCESTOR".into());
        }
        current = candidate;
    }
    let final_entry = components
        .get(&name(&current)?)
        .and_then(Option::as_ref)
        .ok_or("LOOKUP_TARGET_NOT_OBSERVED")?;
    let kind = match final_entry.kind {
        "file" => LookupKind::File,
        "directory" => LookupKind::Directory,
        _ => return Err("LOOKUP_FINAL_KIND".into()),
    };
    if lookup.kind != kind || lookup.target.as_ref() != Some(&current) {
        return Err("LOOKUP_TARGET_DIFFERS_FROM_ADMISSION".into());
    }
    Ok(Observation {
        kind,
        target: Some(current),
        missing_component: None,
        components,
    })
}

impl Monitor {
    pub(super) fn install_lookups(&mut self, lookups: &[Lookup]) -> Result<()> {
        if lookups.len() > 4096 {
            return Err("LOOKUP_COUNT_LIMIT".into());
        }
        let mut seen = BTreeSet::new();
        for lookup in lookups {
            if !seen.insert(&lookup.path) {
                return Err("LOOKUP_DUPLICATE".into());
            }
        }
        self.lookups = lookups.to_vec();
        let exclude = self.exclude.clone();
        for lookup in lookups {
            resolve(lookup, &exclude, |path, scope| self.add(path, scope))?;
        }
        self.drain()
    }

    pub(super) fn lookup_snapshot(&self) -> Result<BTreeMap<String, Observation>> {
        self.lookups
            .iter()
            .map(|lookup| {
                Ok((
                    name(&lookup.path)?,
                    resolve(lookup, &self.exclude, |_, _| Ok(()))?,
                ))
            })
            .collect()
    }
}
