use super::common::{Lookup, LookupKind};
use super::monitor::Monitor;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "bullet-lookup-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("real")).unwrap();
        fs::write(path.join("real/config"), "actual input\n").unwrap();
        Self(path)
    }
    fn lookup(&self, relative: &str, kind: LookupKind) -> Lookup {
        Lookup {
            path: self.0.join(relative),
            target: (kind != LookupKind::Absent)
                .then(|| fs::canonicalize(self.0.join(relative)).unwrap()),
            kind,
        }
    }
    fn monitor(&self, lookup: Lookup) -> Monitor {
        let mut monitor = Monitor::new(vec![]).unwrap();
        monitor.install_lookups(&[lookup]).unwrap();
        monitor
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn absent_leaf_and_first_missing_ancestor_creation_then_removal_latch() {
    for path in ["absent", "missing/ancestor/config"] {
        let fixture = Fixture::new();
        let mut monitor = fixture.monitor(fixture.lookup(path, LookupKind::Absent));
        let baseline = monitor.snapshot().unwrap();
        if path == "absent" {
            fs::write(fixture.0.join(path), "transient").unwrap();
            fs::remove_file(fixture.0.join(path)).unwrap();
        } else {
            fs::create_dir(fixture.0.join("missing")).unwrap();
            fs::remove_dir(fixture.0.join("missing")).unwrap();
        }
        assert_eq!(monitor.snapshot().unwrap(), baseline);
        assert!(
            monitor
                .checkpoint(&baseline)
                .unwrap_err()
                .contains("SOURCE_MUTATION")
        );
    }
}

#[test]
fn final_and_intermediate_alias_replacement_even_with_same_target_latch() {
    for (name, target, suffix) in [
        ("final", "real/config", "final"),
        ("intermediate", "real", "intermediate/config"),
    ] {
        let fixture = Fixture::new();
        let link = fixture.0.join(name);
        symlink(target, &link).unwrap();
        let mut monitor = fixture.monitor(fixture.lookup(suffix, LookupKind::File));
        let baseline = monitor.snapshot().unwrap();
        fs::rename(&link, fixture.0.join("old-link")).unwrap();
        symlink(target, &link).unwrap(); // Same canonical target and bytes.
        fs::remove_file(&link).unwrap();
        fs::rename(fixture.0.join("old-link"), &link).unwrap();
        assert!(monitor.checkpoint(&baseline).is_err());
    }
}

#[test]
fn target_write_restore_and_sibling_positive_control() {
    let fixture = Fixture::new();
    symlink("real/config", fixture.0.join("link")).unwrap();
    let mut monitor = fixture.monitor(fixture.lookup("link", LookupKind::File));
    let baseline = monitor.snapshot().unwrap();
    fs::write(fixture.0.join("unrelated"), "allowed sibling").unwrap();
    fs::remove_file(fixture.0.join("unrelated")).unwrap();
    monitor.checkpoint(&baseline).unwrap();
    let path = fixture.0.join("real/config");
    let before = fs::read(&path).unwrap();
    fs::write(&path, "transient").unwrap();
    fs::write(&path, before).unwrap();
    assert!(monitor.checkpoint(&baseline).is_err());
}

#[test]
fn chained_relative_aliases_preserve_kernel_dotdot_order() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("real/dir")).unwrap();
    symlink("real/dir", fixture.0.join("first")).unwrap();
    symlink("first/../config", fixture.0.join("second")).unwrap();
    let mut monitor = fixture.monitor(fixture.lookup("second", LookupKind::File));
    let baseline = monitor.snapshot().unwrap();
    monitor.checkpoint(&baseline).unwrap();
    fs::write(fixture.0.join("real/config"), "changed").unwrap();
    assert!(monitor.checkpoint(&baseline).is_err());
}

#[test]
fn dangling_alias_binds_missing_target_and_link() {
    let fixture = Fixture::new();
    symlink("missing/config", fixture.0.join("link")).unwrap();
    let mut monitor = fixture.monitor(fixture.lookup("link", LookupKind::Absent));
    fs::create_dir(fixture.0.join("missing")).unwrap();
    fs::remove_dir(fixture.0.join("missing")).unwrap();
    assert!(monitor.drain().is_err());
}

#[test]
fn cycles_special_inputs_nondirectories_and_wrong_expected_target_refuse() {
    let fixture = Fixture::new();
    symlink("cycle", fixture.0.join("cycle")).unwrap();
    let mut monitor = Monitor::new(vec![]).unwrap();
    assert!(
        monitor
            .install_lookups(&[fixture.lookup("cycle", LookupKind::Absent)])
            .unwrap_err()
            .contains("CYCLE_OR_LIMIT")
    );
    for path in ["real/config/child", "real/config/../child"] {
        let lookup = Lookup {
            path: fixture.0.join(path),
            kind: LookupKind::Absent,
            target: None,
        };
        assert!(
            Monitor::new(vec![])
                .unwrap()
                .install_lookups(&[lookup])
                .is_err()
        );
    }
    let mut wrong = fixture.lookup("real/config", LookupKind::File);
    wrong.target = Some(fixture.0.join("other"));
    assert!(
        Monitor::new(vec![])
            .unwrap()
            .install_lookups(&[wrong])
            .is_err()
    );
    let mut monitor = Monitor::new(vec![fixture.0.join("real")]).unwrap();
    assert!(
        monitor
            .install_lookups(&[fixture.lookup("real/config", LookupKind::File)])
            .is_err()
    );
    let socket_path = fixture.0.join("socket");
    let _socket = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
    let socket = Lookup {
        path: socket_path.clone(),
        kind: LookupKind::File,
        target: Some(socket_path),
    };
    assert!(
        Monitor::new(vec![])
            .unwrap()
            .install_lookups(&[socket])
            .unwrap_err()
            .contains("SPECIAL_INPUT_REFUSED")
    );
    let excess = vec![fixture.lookup("missing", LookupKind::Absent); 4097];
    assert!(
        Monitor::new(vec![])
            .unwrap()
            .install_lookups(&excess)
            .unwrap_err()
            .contains("LOOKUP_COUNT_LIMIT")
    );
}
