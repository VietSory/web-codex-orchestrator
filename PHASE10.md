# Phase 10 — Registered Web Operation Application

Phase 10 begins the transition from Phase 9 authority registration to controlled mutation of an isolated worktree.

## Goal

Apply only operations from an immutable, registered Web implementation pack, and only when every operation still matches the exact repository preimage that Web reviewed.

The application path is intentionally split into two stages:

1. **whole-plan preflight** — read-only, deterministic, fail-closed;
2. **mutation/commit stage** — implemented only after the preflight contract is stable and covered by adversarial tests.

No operation may write before the complete preflight succeeds.

## Current P10 slice

`preflightWebOperations` provides a bounded deterministic plan and verifies:

- the artifact registration still matches the pack authority;
- the worktree root is a real directory, not a symlink;
- every operation path is safe and cannot target `.git`;
- no two operations target the same path;
- target ancestors cannot be symlinks or non-directories;
- target files are regular non-symlink files when they exist;
- the observed SHA-256 preimage exactly matches the Web operation;
- create/replace/delete existence semantics are consistent;
- payload entries exist and match their bound SHA-256;
- preflight performs zero worktree mutation;
- identical state produces an identical plan digest.

## Performance and usability rules

Preflight is deliberately one pass over operation targets and payload buffers already loaded by the registered pack reader. It does not recursively rescan the repository and does not load Codex session history. Diagnostics identify the exact failing path/op while avoiding payload contents.

This design also shields WCO from known upstream session/runtime failure modes rather than trying to modify Codex internals. Current negative requirements include:

- do not depend on large Codex thread replay for operation application;
- persist WCO-owned authority and checkpoints independently of Codex session persistence;
- keep state/log growth bounded;
- expose explicit progress/checkpoint state instead of relying on a potentially blank or slow Codex resume UI;
- never treat an in-memory Codex session as authoritative over persisted WCO state.

These constraints are informed by upstream Codex reports involving expensive full-session listing/history loading, slow/blank long-thread resume, and rollout persistence failures. WCO owns mitigations only at its orchestration boundary.

## Non-goals of this slice

This slice does not yet mutate files, create commits, push branches, merge PRs, mark PRs Ready, or alter OpenAI Codex CLI/app/agent internals.

The next P10 slice will add a crash-safe mutation journal/rollback boundary on top of this preflight plan, followed by exact postimage verification and recovery tests.
