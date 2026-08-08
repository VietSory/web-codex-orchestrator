# Phase 2 — Secure ZIP intake

Phase 2 accepts `wco-task-*.zip` input only after lstat checks, streaming
SHA-256 hashing, lazy ZIP inspection, path/type/size policy checks, isolated
quarantine extraction, logical-root resolution, checksum verification, and the
existing bundle contract validation.

The lifecycle is:

```text
ZIP -> inspect -> quarantine -> extract -> checksums -> contract -> accepted/rejected
```

No content under `payload/` is executed. No validation command is executed.
There is no watcher, browser bridge, Codex integration, Git operation, GitHub
operation, or network request in this phase.

The intake command returns exit code 0 for accepted bundles, 1 for policy or
contract rejection, 2 for invalid CLI usage, and 3 for operational failures.
