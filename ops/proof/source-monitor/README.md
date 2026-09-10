# Source monitor component

This finite-lifetime Linux child detects transient ordinary filesystem writes
under a cooperative source freeze. It is owned by the existing proof wrapper;
it neither grants write custody nor coordinates agents. Component tests do not
qualify the wrapper, a clean source proof, an installed product, or other hosts.

Build before freezing sources with the pinned Rust 1.97.1 toolchain,
`cargo build --locked --offline --manifest-path ops/proof/source-monitor/Cargo.toml`
and a private `CARGO_TARGET_DIR` outside the input trees. Bind the monitor source,
lockfile, build-tool binaries and resulting executable in the wrapper's subject.
The executable is additionally inventoried and watched by the monitor itself.
No repository-local Cargo target is admitted as an implicit exclusion.

The only argument is an absolute JSON configuration path:

```json
{
  "schema": "bullet.source-monitor.config.v1",
  "nonce": "32_or_more_random_alphanumeric_characters",
  "owner_pid": 12345,
  "owner_record": "/private/proof-lock/owner",
  "roots": ["/checkout", "/pinned/toolchain", "/private/writer-release-packet"],
  "exclude": ["/checkout/dist", "/checkout/node_modules/.vite"],
  "inventory_path": "/private/observation/input-inventory.json",
  "max_seconds": 3600
}
```

The owner PID must be the actual direct parent. The existing wrapper validates
its own owner-record semantics and private parent-directory custody; this child
requires a same-UID regular owner file, mode 0600, one hard link, and binds its
identity and bytes. Config, owner record and monitor executable cannot be
excluded. Parent process start ticks prevent PID reuse. EOF, owner death,
deadline, malformed requests, missing watches and overflow are non-passing.

All root descendants are inputs, including ignored files, generated contracts,
`.git` index/refs/config/attributes and installed dependencies. No Git status
command or ignore pattern defines the subject. The caller must explicitly add
external selected tools, scripts, package caches, Git config, dependency roots,
release/freeze records and any other inputs actually consumed by the proof.
Direct symlinks and their resolved targets are bound. Symlinked input ancestors,
indirect symlink chains, dangling links, links into excluded outputs, special
files and non-UTF-8 input names refuse. Select canonical tool/root paths. Each named
exclusion permits precisely that path and its descendants; it never permits a
similar prefix. Review these output subtrees and keep proof tools' caches there
or outside the inputs. Exclusions are bound into the inventory. They must not
hide sources or executable dependencies. An input directory's creation times
and link count are omitted because admitted output creation changes them;
directory inode/device/permissions/ownership remain bound.

File and directory watches, including ancestor replacement watches, are
installed before inventory and READY. File inode watches additionally detect
writes through external hard links. Every relevant event latches refusal even
if bytes, paths or metadata are restored. Every checkpoint drains events,
recomputes the deterministic inventory, and drains again. Lost watch,
unmount, overflow, unknown descriptor or malformed event is never recovered
into a passing generation. The first refusal is written to stderr and exits 2.
Other platforms print `SOURCE_MONITOR_UNAVAILABLE` and exit 72.

The inventory is created exclusively at mode 0600, contains hashes rather than
file contents, and must be retained as a private evidence artifact. Its SHA-256
is the `subject` in newline-delimited JSON stdout acknowledgements. No other
stdout is emitted. Startup returns `command: "READY"`, sequence 0, schema
`bullet.source-monitor.ack.v1`, nonce, subject, monitor PID/start ticks, owner
PID/start ticks, watch-scope SHA-256 and input count. The parent must validate all
fields, bind them to its active custody generation, and keep the channel live.

Send newline-delimited JSON on stdin, with monotonically increasing sequence:

```json
{"command":"CHECK","nonce":"same_nonce","subject":"READY_subject","sequence":1}
{"command":"FINISH","nonce":"same_nonce","subject":"READY_subject","sequence":2}
```

Each CHECK returns CHECKED after revalidation. FINISH returns FINISHED and exits
zero only after final revalidation. A file containing an old acknowledgement is
not a live response. The parent must impose response deadlines and require
both the exact FINISHED acknowledgement and observed zero child exit. It must
reject EOF, child death, mismatched subjects/sequences and all nonzero exits,
retain the original proof-child result separately, and invalidate all stage
observations when the overall monitoring generation fails. Send FINISH only
after final source read-back and observation preparation; only then may the
wrapper accept the generation and release custody. The acknowledged cut is
the end of monitoring, not an enduring claim that files can never change.

Linux inotify does not observe every hostile write mechanism: memory-mapped
writes and mounted-over trees have documented blind spots. Require qualified
local filesystem/mount conditions and actual writer-release/freeze custody.
This component must not substitute for containment or native macOS/Windows
owner identity, ACL, file-identity and stale-owner qualification. See the
[Linux inotify manual](https://man7.org/linux/man-pages/man7/inotify.7.html).

`cargo test --locked --offline` executes disposable fixture tests for restored
writes, exact output exclusions, replacements, hard links, Git/dependency/
generated inputs, metadata, topology, symlinks, overflow and malformed events.
The wrapper's own integration suite must additionally test the complete live
protocol, actual compilation overlap, monitor death and observation refusal.
# Later verification and cleanup

`--verify-inventory /absolute/inventory.json` installs live watches before
comparing the retained inventory with current inputs. Its single JSON success
acknowledgement binds the inventory hash. The caller pins the executable hash,
enforces an external response deadline, and requires zero exit. Only the exact
reserved `.git/bullet-ci.lock.d` subtree is classified as ephemeral for this
later comparison. Index, refs, ignored dependencies, tools, admission and review
records remain inputs. A changed-and-restored write during comparison refuses.
Historical inspection alone never qualifies current inputs.

Initial admission rejects hidden index flags, unmerged/staged tree differences,
and any raw tracked blob or executable/symlink mode differing from the admitted
HEAD. Git clean filters and normal status cannot substitute for this comparison.
The wrapper repeats exact admission/tool/review bindings and tracked-byte checks
after READY installs its watches, before a proof stage can start.

`--terminate-monitor PID START_TICKS OWNER_PID` acquires a Linux pidfd before
checking start and parent identity. It signals only that descriptor, observes
termination with a bounded poll, and never falls back to signaling an integer
PID. An absent or replaced original identity is reported without signaling its
replacement. Missing start identity or uncertain termination is non-passing;
the wrapper retains its lock. This operation uses the documented Linux
[pidfd interface](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html).

The wrapper rejects durable session refusal and generation invalidation markers
even when old completed public observation bytes still exist. The module split
is part of the exact build source inventory; all Rust modules and this contract
must be bound by the admitted build record.
