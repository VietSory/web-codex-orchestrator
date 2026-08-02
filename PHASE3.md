# Phase 3 — Inbox and isolated worktree preparation

Phase 3 bridges secure Phase 2 intake to a future execution agent. It scans a
dedicated inbox for stable `wco-task-*.zip` files, routes schema 1.2 bundles by
logical repository ID through trusted local configuration, verifies the
allowlisted remote and exact base commit, and creates a clean local Git
worktree under state storage.

The preparation boundary ends at `READY_FOR_CODEX`. It never executes payloads,
patches, validation commands, Codex, commits, pushes, Pull Requests, merges,
GitHub APIs, or browser automation.

Run storage is:

```text
state/
├── accepted/ rejected/ quarantine/
├── runs/<task-id>/<archive-sha256>/{run.json,events.jsonl,preparation.json}
├── worktrees/<task-id>/<archive-sha256>/repository/
├── locks/
└── inbox-index.json
```

Use `examples/config.example.json` as a starting point, replacing its
placeholder path in a user-owned configuration file. The configuration must be
a regular non-symlink JSON file and is the only source of repository paths.
