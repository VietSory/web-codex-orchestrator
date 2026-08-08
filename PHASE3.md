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
├── git-runtime/{empty-hooks,empty-config}
└── inbox-index.json
```

Use `examples/config.example.json` as a starting point, replacing its
placeholder path in a user-owned configuration file. The configuration must be
a regular non-symlink JSON file and is the only source of repository paths.

Before creating a worktree, preparation inspects the effective repository
configuration and blocks `GIT_CHECKOUT_FILTER_UNSAFE` when a smudge, process,
or required filter is present. Git runs use an empty global/system runtime,
`GIT_TERMINAL_PROMPT=0`, and a controlled empty hooks directory. Worktrees are
created detached with `--no-checkout`, then the validated branch is attached
without checkout hooks; tracked bytes are materialized only after the filter
check. A branch is removed during failure cleanup only after this operation has
successfully created it.

HTTP(S) registry URLs containing userinfo or credentials are rejected. Receipt
and journal remote URLs are sanitized, and credential-bearing values are never
written to state storage or CLI output.

The test-to-case mapping is maintained in
[`PHASE3-COVERAGE.md`](./PHASE3-COVERAGE.md).
