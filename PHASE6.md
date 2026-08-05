# Phase 6: Deterministic Result Bundle & Web Review Handoff

Phase 6 produces a fully deterministic ZIP archive containing all execution evidence and artifacts for web-based review. It guarantees that any two orchestrator runs with the same input receipts and git source trees will generate a byte-for-byte identical ZIP file.

## Architecture

Phase 6 implements a strict closed-world package generation process:
- **Canonical JSON:** All JSON metadata is sorted lexically and strictly typed.
- **Deterministic ZIP:** Uses `yazl` and `yauzl` with hardcoded file modes (`0100644`) and timestamps (`1980-01-01T00:00:00Z`).
- **Validation Pipeline:** Upstream receipts (Phase 4 Execution, Phase 5A Git Publish, Phase 5B Draft PR) are validated in order and their hashes are injected.
- **Argv-only Git Extraction:** Git tree structures and file changes are read purely via safe Git CLI commands, bypassing all external shell invocations.

## State Machine
The Phase 6 process advances through these logical states:
`READY_TO_BUILD` → `BUILDING` → `BUILT` → `VERIFIED` → `READY_FOR_WEB_REVIEW`

## Output Format
The resulting ZIP bundle is deposited in `handoff/` and adheres strictly to `RESULT-BUNDLE-SCHEMA.md`.

## CLI Usage
```bash
wco package-result --run-id <run-id> --state-dir <directory> --config <config.json> [--json]
wco result-bundle-status --run-id <run-id> --state-dir <directory> [--json]
```
