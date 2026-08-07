# Phase 9 Coverage — Web Authority Protocol v2

Phase 9 is complete only when executable boundaries match `PHASE9.md`. Documentation is not proof by itself.

## Release gate

```bash
npm run phase9:release-gate
```

The gate includes typecheck, the top-level unit/fake-integration suite, Phase 8 regression E2E, production build, and compiled CLI integrations including Phase 9.

## Authority matrix

| Invariant | Production boundary | Executable coverage |
| --- | --- | --- |
| Web pack input is bounded and ZIP-path safe | `src/web-authority/pack-reader.ts` | `P9-AUTH-001`, `P9-AUTH-002`, existing ZIP hardening patterns |
| `checksums.json` covers all non-checksum entries exactly | `pack-reader.ts` | `P9-AUTH-002` |
| Manifest binds exact run/task/repository/tree/spec documents | `pack-reader.ts`, `authority-service.ts` | `P9-AUTH-001`, `P9-AUTH-004` |
| Canonical Phase 3 run/config remains higher authority than Web manifest | `authority-service.ts`, `trusted-run-context.ts` | `P9-AUTH-001` plus Phase 7 trusted-run tests |
| Registration requires clean worktree at exact locked base | `authority-service.ts` | `P9-AUTH-005` |
| Web repository inventory equals actual `git ls-tree` inventory | `authority-service.ts` | `P9-AUTH-004` |
| Read coverage may only reference exact verified inventory object IDs | `authority-service.ts` | valid path in `P9-AUTH-001`; adversarial expansion required before merge |
| Accepted Task Bundle spec set is recomputed, not trusted from Web | `authority-service.ts` | valid path in `P9-AUTH-001`; spec-drift adversarial test required before merge |
| Create/replace/delete operations are closed-world and `.git/**` is forbidden | `pack-reader.ts` | protocol validator coverage; adversarial path cases required before merge |
| Existing targets require exact preimage SHA-256 | `pack-reader.ts`, `authority-service.ts` | `P9-AUTH-003` |
| Payload bytes are hash-bound | `pack-reader.ts` | `P9-AUTH-002` |
| Registry location is state-root confined and content-addressed | `paths.ts`, `registry.ts` | `P9-AUTH-001`; symlink/path adversarial test required before merge |
| Existing immutable artifact path can only adopt identical bytes | `registry.ts` | second registration in `P9-AUTH-001` |
| Registered archive is re-hashed when status is read | `registry.ts` | compiled CLI/status path plus adversarial tamper test required before merge |
| Web response envelope is closed-world and exact-artifact/payload-bound | `response-validator.ts` | `P9-AUTH-006` |
| Compiled Phase 9 CLI exercises registration and registry status | `standalone-cli.ts`, `web-authority-cli.ts` | `CLI-P9-001` |

## Required maintainer hardening before Phase 9 freeze

The following are intentionally listed as open coverage work instead of being hidden behind a broad “covered” claim:

- preimage read must be allocation-bounded and TOCTOU-safe;
- registry record read must be allocation-bounded;
- source receipt enums and project-map/read-coverage structures need closed-world runtime validation;
- state-path symlink replacement and registered archive mutation require explicit adversarial tests;
- accepted Task Bundle/spec drift requires explicit adversarial coverage;
- read-coverage object mismatch requires explicit adversarial coverage;
- operation traversal/collision/`.git` targets require explicit tests;
- exact-head release gate and independent maintainer audit are still required.

These items are merge blockers for Phase 9, not deferred Phase 10 work.
