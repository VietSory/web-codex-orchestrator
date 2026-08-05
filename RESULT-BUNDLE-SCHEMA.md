# RESULT BUNDLE SCHEMA 1.1

Archive filename:

```text
wco-result-<task-id>-<published-sha12>.zip
```

No explicit directory entries are required. All paths use `/`.

## Exact required entries

```text
RESULT.md
REVIEW.md
manifest.json
checksums.json

task/README.md
task/REQUEST.md
task/PLAN.md
task/RULES.md
task/RESEARCH.md
task/SOURCES.md
task/VALIDATION.md
task/manifest.json
task/checksums.json
task/spec-lock.json
task/acceptance.json
task/test-matrix.json
task/validation.json
task/risk-policy.json

evidence/execution.json
evidence/acceptance.json
evidence/verification.json
evidence/terra-review.json
evidence/sol-review.json
evidence/git-publish.json
evidence/github-draft-pr.json
evidence/event-summary.json

repository/diff.patch
repository/changed-files.json
repository/deleted-files.json

github/pull-request.json

review/WEB-REVIEW-CONTRACT.md
review/web-review-policy.json
review/web-review-verdict.schema.json
review/revision-request.schema.json
```

For each changed non-deleted regular file:

```text
repository/source/<original-repository-path>
```

No task `payload/` file is copied.

## Task spec lock

`task/spec-lock.json` is generated from the immutable accepted task bundle. It
contains the original task archive SHA-256, accepted bundle tree SHA-256 and a
lexical descriptor for every authoritative task contract file. The canonical
hash of those descriptors is `spec_set_sha256`.

The authoritative set includes the task README, manifest, checksums, all locked
Markdown contract files, acceptance matrix, test matrix, validation contract and
risk policy. Payload bytes are excluded from Web review authority and export.

The Result Bundle manifest, Phase 6 receipt and every Web verdict bind the same
`spec_set_sha256`.

## Canonical JSON

- UTF-8 without BOM.
- Recursive Unicode-code-point key order.
- Semantic arrays retain order; set-like arrays are sorted before serialization.
- Two-space indentation, LF, one trailing newline.
- No undefined, NaN, Infinity, comments or duplicate keys.

## Checksums

`checksums.json` lexically covers every archive entry except itself with path,
SHA-256 and size. No circular checksum is permitted.

## ZIP canonicalization

- lexical entry order;
- fixed `1980-01-01T00:00:00Z` timestamp;
- normalized regular-file mode `0100644`;
- UTF-8 names, no comment, encryption or directory entries;
- fixed documented compression policy;
- strict traversal, Windows-name, Unicode-normalization and case-fold collision
  checks;
- no symlink, hardlink, device, FIFO, socket or submodule entries.

## Public evidence

Internal receipts are projected into explicit public DTOs. Absolute paths,
thread IDs, prompts, hidden reasoning, auth data, environment values and private
log paths are excluded. Bounded command output is redacted before hashing.

## Source fidelity

- Diff is generated from exact base and published commit with external diff and
  textconv disabled.
- Source bytes come from the published commit object, never mutable worktree.
- File mode/content digests are independently verified.
- Deleted files have inventory/diff evidence but no source entry.

## Review resources

The four `review/` resources are exact versioned embedded resources. Their
hashes are included in manifest/checksums. A downstream reviewer must validate
its verdict against them and against `task/spec-lock.json`.
