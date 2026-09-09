# Contract boundary

Read the repository `AGENTS.md` first. This cell owns the generated Portal
clients listed in `agent/generated-zones.toml`.

- Owns: `src/generated/` after the kernel contract sync.
- Forbidden: hand-editing generated bindings, renaming wire vocabulary to
  silence auditors, or treating the bundle as an owned product module.
- Proof: `just contract` / `bash scripts/ci-local.sh contract`.
