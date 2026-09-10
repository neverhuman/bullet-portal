#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("SOURCE_MONITOR_UNAVAILABLE: native Linux custody is required");
    std::process::exit(72);
}

#[cfg(target_os = "linux")]
fn main() {
    if let Err(error) = operations::run() {
        eprintln!("SOURCE_MONITOR_REFUSED: {error}");
        std::process::exit(2);
    }
}

#[cfg(target_os = "linux")]
mod common;
#[cfg(target_os = "linux")]
mod monitor;
#[cfg(target_os = "linux")]
mod operations;
#[cfg(target_os = "linux")]
mod protocol;

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::monitor::*;
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "bullet-monitor-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&p).unwrap();
            fs::write(p.join("input.rs"), b"fn main() {}\n").unwrap();
            fs::create_dir(p.join("output")).unwrap();
            Self(p)
        }
        fn monitor(&self) -> Monitor {
            let mut m = Monitor::new(vec![self.0.join("output")]).unwrap();
            m.roots.insert(self.0.clone());
            m.ancestors(&self.0).unwrap();
            m.install(&self.0, &mut BTreeSet::new()).unwrap();
            m.drain().unwrap();
            m
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn changed_and_restored_bytes_permanently_refuse() {
        let f = Fixture::new();
        let mut m = f.monitor();
        let p = f.0.join("input.rs");
        let original = fs::read(&p).unwrap();
        fs::write(&p, b"changed").unwrap();
        fs::write(&p, &original).unwrap();
        assert_eq!(fs::read(&p).unwrap(), original);
        assert!(m.drain().unwrap_err().contains("SOURCE_MUTATION"));
        assert!(m.drain().is_err());
    }
    #[test]
    fn only_exact_output_subtree_is_allowed() {
        let f = Fixture::new();
        let mut m = f.monitor();
        let before = m.snapshot().unwrap();
        fs::write(f.0.join("output/artifact"), b"permitted").unwrap();
        fs::create_dir(f.0.join("output/nested")).unwrap();
        m.checkpoint(&before).unwrap();
        fs::write(f.0.join("output-extra"), b"not permitted").unwrap();
        assert!(m.checkpoint(&before).is_err());
    }
    #[test]
    fn atomic_replacement_and_restoration_refuse() {
        let f = Fixture::new();
        let mut m = f.monitor();
        let p = f.0.join("input.rs");
        fs::rename(&p, f.0.join("output/original")).unwrap();
        fs::write(&p, b"replacement").unwrap();
        fs::remove_file(&p).unwrap();
        fs::rename(f.0.join("output/original"), &p).unwrap();
        assert!(m.drain().is_err());
    }
    #[test]
    fn outside_hardlink_write_refuses() {
        let f = Fixture::new();
        let alias = Fixture::new();
        fs::hard_link(f.0.join("input.rs"), alias.0.join("alias")).unwrap();
        let mut m = f.monitor();
        fs::write(alias.0.join("alias"), b"outside").unwrap();
        assert!(m.drain().is_err());
    }
    #[test]
    fn index_tools_generated_and_untracked_are_not_ignored() {
        for path in [
            ".git/index",
            ".git/HEAD",
            "node_modules/tool.js",
            "src/generated/api.ts",
            "untracked",
        ] {
            let f = Fixture::new();
            let p = f.0.join(path);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, b"before").unwrap();
            let mut m = f.monitor();
            fs::write(&p, b"after").unwrap();
            fs::write(&p, b"before").unwrap();
            assert!(m.drain().is_err(), "{path}");
        }
    }
    #[test]
    fn transient_metadata_and_directory_creation_refuse() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        let p = f.0.join("input.rs");
        let mut m = f.monitor();
        let mode = fs::metadata(&p).unwrap().permissions();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&p, mode).unwrap();
        assert!(m.drain().is_err());
        let mut m = f.monitor();
        fs::create_dir(f.0.join("transient")).unwrap();
        fs::remove_dir(f.0.join("transient")).unwrap();
        assert!(m.drain().is_err());
    }
    #[test]
    fn symlink_target_and_root_replacement_are_watched() {
        let f = Fixture::new();
        let target = Fixture::new();
        std::os::unix::fs::symlink(target.0.join("input.rs"), f.0.join("link")).unwrap();
        let mut m = f.monitor();
        fs::write(target.0.join("input.rs"), b"changed").unwrap();
        assert!(m.drain().is_err());
        let mut m = f.monitor();
        let moved = f.0.with_extension("moved");
        fs::rename(&f.0, &moved).unwrap();
        fs::rename(&moved, &f.0).unwrap();
        assert!(m.drain().is_err());
    }
    #[test]
    fn overflow_lost_watch_and_malformed_records_fail_closed() {
        for mask in [libc::IN_Q_OVERFLOW, libc::IN_IGNORED, libc::IN_UNMOUNT] {
            let mut m = Monitor::new(vec![]).unwrap();
            let mut raw = Vec::new();
            raw.extend((-1_i32).to_ne_bytes());
            raw.extend(mask.to_ne_bytes());
            raw.extend([0; 8]);
            m.parse(&raw).unwrap();
            assert!(m.healthy().unwrap_err().contains("WATCH_LOST"));
        }
        let mut m = Monitor::new(vec![]).unwrap();
        assert!(m.parse(&[0; 15]).is_err());
        m.event(999, libc::IN_MODIFY, None);
        assert!(m.healthy().is_err());
    }
    #[test]
    fn indirect_symlinks_refuse_instead_of_hiding_a_resolution_dependency() {
        let f = Fixture::new();
        let target = Fixture::new();
        std::os::unix::fs::symlink(target.0.join("input.rs"), target.0.join("second-link"))
            .unwrap();
        std::os::unix::fs::symlink(target.0.join("second-link"), f.0.join("link")).unwrap();
        let mut m = Monitor::new(vec![]).unwrap();
        assert!(m
            .install(&f.0, &mut BTreeSet::new())
            .unwrap_err()
            .contains("INDIRECT_SYMLINK"));
    }
}
