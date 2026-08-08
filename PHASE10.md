# Phase 10 — Registered Web Operation Application

Phase 10 transitions Phase 9 authority registration into controlled mutation of an isolated worktree.

## Goal

Apply only operations from an immutable, registered Web implementation pack, and only when every operation still matches the exact repository preimage that Web reviewed.

The application path has two explicit stages:

1. **whole-plan preflight** — read-only, deterministic, fail-closed;
2. **journaled mutation** — revalidates every preimage immediately before mutation, persists rollback material before each write, verifies exact postimages, and rolls back on failure.

No operation may write before the complete preflight succeeds.

## Current P10 implementation

`preflightWebOperations` verifies:

- the artifact registration still matches the pack authority;
- the worktree root is a real directory, not a symlink;
- every operation path is safe and cannot target `.git`;
- no two operations target the same path;
- target ancestors cannot be symlinks or non-directories;
- target files are regular non-symlink files when they exist;
- observed preimages are hashed through bounded, stable file-handle reads rather than unbounded `readFile()` calls;
- the opened file identity/size is checked against `lstat` before and after hashing, with `O_NOFOLLOW` where the platform exposes it;
- the observed SHA-256 preimage exactly matches the Web operation;
- create/replace/delete existence semantics are consistent;
- payload entries exist and match their bound SHA-256;
- preflight performs zero worktree mutation;
- identical state produces an identical plan digest.

`applyWebOperations` and `recoverWebOperationTransaction` add:

- an external WCO-owned transaction journal, independent of Codex thread/session persistence;
- a unique transaction directory per exact preflight plan, preventing blind replay of the same plan;
- whole-plan verification that every operation parent already exists as a real directory before mutation begins;
- immediate preimage revalidation before every individual operation;
- checksummed rollback backups persisted and synced before each replace/delete mutation;
- temporary-file + sync + rename writes for payloads and journal updates;
- exact postimage SHA-256 verification after each mutation;
- rollback in reverse operation order after an application failure;
- idempotent recovery of already rolled-back or committed journals;
- bounded streaming hash verification for worktree preimages and backup artifacts.

Directory creation is intentionally not implicit in this phase: a pack that targets a missing parent fails before mutation. This keeps the trust boundary simple until directory-operation semantics can be specified and tested separately.

## Performance, security, and usability rules

Operation application does not recursively rescan the repository and does not load Codex session history. File hashing is bounded and chunked so a hostile or accidentally huge worktree target cannot force an unbounded allocation. Backup verification and restoration are file-copy based rather than loading full backups into memory. Diagnostics identify the failing path/op while avoiding payload contents.

The journal/checkpoint path is deliberately WCO-owned. That shields operation recovery from upstream session/runtime failure modes rather than attempting to modify Codex internals. Current negative requirements include:

- do not depend on large Codex thread replay for operation application or recovery;
- persist WCO-owned authority, journals, and checkpoints independently of Codex session persistence;
- keep state/log growth bounded;
- expose explicit progress/checkpoint state instead of relying on a potentially blank or slow Codex resume UI;
- never treat an in-memory Codex session as authoritative over persisted WCO state;
- never infer recoverability merely from the existence of a displayed Codex session ID;
- keep mutation recovery valid even if Codex local indexing/session state is stale or missing.

These constraints are consistent with upstream reports observed in 2026: Codex resume can spend seconds scanning many rollout files; long-thread resume can remain blank while consuming CPU; session persistence errors can leave disk state divergent from in-memory state; and abrupt shutdowns have been reported to corrupt or regress local application state. WCO therefore uses explicit bounded state and atomic-ish temp/sync/rename persistence at its own boundary.

## Security boundary

Node's portable filesystem APIs cannot provide a universal multi-file atomic transaction or fully eliminate every path race on every host filesystem. P10 narrows that risk with safe relative paths, ancestor checks, stable file-handle hashing, `O_NOFOLLOW` when available, immediate preimage revalidation, same-directory temporary writes, durable rollback material, and postimage verification. Native `openat`-style directory-handle confinement is outside this TypeScript portability boundary and must not be falsely claimed.

## Tests

Phase 10 regression coverage includes deterministic mutation-free preflight, preimage drift rejection, symlink rejection, bounded-preimage rejection, successful journaled application, drift between preflight and apply, exact postimage verification, and idempotent crash recovery from checksummed rollback material.

## Remaining P10 gate

Before Phase 10 is frozen, exact-head CI must pass and the phase still needs a strict maintainer audit focused on transaction replay, partial-journal corruption, permission/mode behavior, Windows rename semantics, state-directory containment, and adversarial recovery races. Phase 10 does not merge PRs, mark PRs Ready, force-push, or alter OpenAI Codex CLI/app/agent internals.
