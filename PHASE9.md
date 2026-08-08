# Phase 9 — Web Authority Protocol v2

## Goal

Phase 9 makes Web-authored implementation evidence a registered, hash-bound protocol instead of an informal prompt/patch handoff.

```text
accepted Task Bundle + canonical Phase 3 run
        ↓
Web research / repo inventory / read coverage / project map
        ↓
Web implementation pack v2
        ↓
bounded archive validation
        ↓
canonical run + Git snapshot + spec + preimage attestation
        ↓
immutable Artifact Registry registration
        ↓
REGISTERED_WEB_IMPLEMENTATION_PACK
```

Phase 9 does **not** apply code. Phase 10 may consume only artifacts registered by Phase 9.

## Non-negotiable authority rules

1. No loose prompt, loose patch, clipboard text, or unregistered file may override a registered artifact.
2. `run_id` remains `<task-id>:<accepted-task-bundle-sha256>`.
3. The pack must bind the canonical Phase 3 repository ID, base branch, base commit, Git tree, accepted Task Bundle spec set, and exact operation preimages.
4. Repository inventory must match `git ls-tree` for the locked base commit, not merely claim the same tree SHA.
5. `read-coverage.json` may only claim reads of object IDs present in the verified inventory.
6. Architecture and acceptance locks must bind the same `spec_set_sha256` recomputed from the accepted Task Bundle.
7. `operations.json` is closed-world: `create_file`, `replace_file`, `delete_file` only in Phase 9/10. Each path may occur at most once.
8. Create operations require a null preimage. Replace/delete operations require the SHA-256 of the exact locked worktree file bytes.
9. `.git/**`, absolute paths, traversal, non-canonical paths, path collisions, ZIP symlinks, encrypted entries and directory entries fail closed.
10. A registered artifact is immutable and addressed by archive SHA-256. Registration records are immutable evidence, not mutable authority.
11. Artifact registration requires a clean Phase 3 worktree at the locked base commit.
12. Phase 9 never commits, pushes, opens/updates a PR, marks Ready, merges, or changes the product worktree.

## Web implementation pack v2

Required entries:

- `implementation-pack.json`
- `repository-inventory.json`
- `read-coverage.json`
- `project-map.json`
- `source-receipts.json`
- `preimages.json`
- `architecture-lock.json`
- `acceptance-lock.json`
- `prohibited-changes.json`
- `operations.json`
- `checksums.json`
- zero or more `payload/**` regular files referenced by operations

`checksums.json` covers every other archive entry exactly once, in lexical order.

### Repository inventory

`repository-inventory.json` is the Web-visible snapshot of `git ls-tree -r -l --full-tree <base_commit>` and is verified against Git before registration.

### Read coverage

`read-coverage.json` records which exact Git object IDs Web read and whether each read was `full` or `partial`. It is evidence, not permission to modify the file.

### Project map

`project-map.json` is a reusable navigation/index artifact bound to the same Git tree. Later phases may cache it by tree SHA instead of rebuilding it per turn.

### Source receipts

`source-receipts.json` records locator, access time, content SHA-256 and source authority class. A URL alone is not a receipt.

### Operations and preimages

`operations.json` contains exact intended file operations. `preimages.json` must contain exactly one matching path/hash entry per operation. Payloads are hash-bound separately.

## Artifact Registry

The registry is content-addressed under:

```text
<state>/authority/runs/<task-id>/<task-bundle-sha256>/artifacts/<artifact-sha256>/
  web-implementation-pack.zip
  registration.json
```

The directory structure itself is the primary registry. No mutable central index is needed for authority. A future index may exist only as a derived cache.

## Web response envelope v2

Phase 9 also defines the generic response envelope used by later Web handoffs:

```json
{
  "schema_version": "2.0",
  "kind": "wco-web-response",
  "run_id": "TASK:sha256",
  "response_id": "WEB-RESP-001",
  "in_reply_to_artifact_sha256": "...",
  "decision": "APPROVE | REVISE | ESCALATE",
  "payload_sha256": "...",
  "created_at": "ISO-8601"
}
```

The envelope does not itself grant execution permission. The referenced payload must also be valid for the consuming phase and registered where required.

## Bounded resource posture

Default Phase 9 archive limits:

- archive: 32 MiB
- entries: 512
- one entry: 8 MiB
- total uncompressed: 64 MiB
- operations: 256
- source receipts: 512

Validation is bounded and Web packs are registered once for reuse. This is deliberately compatible with later token/performance work: repository inventory/project map/source receipts are snapshot artifacts, not content that must be regenerated or resent every model turn.

## Exit criteria

Phase 9 is complete only when:

- implementation pack archive validation is bounded and fail-closed;
- canonical run/Git/spec/inventory/preimage binding is executable, not documentation-only;
- immutable registry registration and tamper detection are tested;
- response envelope/schema is defined and validated;
- CLI registration/status paths are compiled and tested;
- documentation and coverage map match production code;
- exact-head Phase 9 release gate is green;
- maintainer audit finds no Phase 9 blocker.
