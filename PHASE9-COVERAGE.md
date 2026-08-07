# Phase 9 Coverage — Web Authority Protocol v2

Phase 9 is complete only when executable boundaries match `PHASE9.md`. Documentation is not proof by itself.

## Release gate

```bash
npm run phase9:release-gate
```

The gate includes typecheck, targeted Phase 9 protocol/semantic/adversarial tests, the complete top-level unit/fake-integration suite, Phase 8 regression E2E, production build, and compiled CLI integrations including Phase 9.

## Authority matrix

| Invariant | Production boundary | Executable coverage |
| --- | --- | --- |
| Web pack input is bounded and ZIP-path safe | `src/web-authority/pack-reader.ts` | `P9-AUTH-001`, `P9-AUTH-002`, existing ZIP hardening regressions |
| `checksums.json` covers all non-checksum entries exactly | `pack-reader.ts` | `P9-AUTH-002` |
| Manifest binds exact run/task/repository/tree/spec documents | `pack-reader.ts`, `authority-service.ts` | `P9-AUTH-001`, `P9-AUTH-004` |
| Canonical Phase 3 run/config remains higher authority than Web manifest | `authority-service.ts`, `trusted-run-context.ts` | `P9-AUTH-001` plus Phase 7 trusted-run tests |
| Registration requires clean worktree at exact locked base | `authority-service.ts` | `P9-AUTH-005` |
| Web repository inventory equals actual `git ls-tree` inventory, including Git's padded `-l` size format | `authority-service.ts` | `P9-AUTH-001`, `P9-AUTH-004` |
| Read coverage may only reference exact verified inventory blob object IDs | `semantic-validator.ts`, `authority-service.ts` | `P9-SEM-002`, `P9-AUTH-001` |
| Project-map paths must exist uniquely in the verified inventory | `semantic-validator.ts` | `P9-SEM-003` |
| Accepted Task Bundle spec set is recomputed from stable bounded reads rather than trusted from Web | `authority-service.ts` | `P9-AUTH-001`, `P9-SEM-004` |
| Source receipt type/authority enums and fields are closed-world at runtime | `semantic-validator.ts` | `P9-SEM-001`, `P9-SEM-005` |
| Architecture/acceptance/prohibited-change documents are snapshot/spec bound and closed-world | `semantic-validator.ts`, `pack-reader.ts` | valid path in `P9-AUTH-001`, semantic suite |
| Create/replace/delete operations are closed-world and `.git/**`/traversal/absolute/backslash targets are forbidden | `pack-reader.ts`, `schemas/web-operations.schema.json` | `P9-MAINT-001`, protocol tests |
| Create requires null preimage; replace/delete require exact SHA-256 | `pack-reader.ts`, operations schema | `P9-AUTH-003` plus schema/runtime alignment |
| Existing preimages are allocation-bounded, no-follow where available, exact-sized and restatted after read | `authority-service.ts` | `P9-AUTH-003`; implementation boundary audited with Phase 7-style bounded-read pattern |
| Payload bytes are hash-bound | `pack-reader.ts` | `P9-AUTH-002` |
| Registry location is state-root confined and content-addressed | `paths.ts`, `registry.ts` | `P9-AUTH-001`, `P9-MAINT-003` |
| Existing immutable artifact path can only adopt identical bytes and preserves the first registration timestamp | `registry.ts` | repeated registration in `P9-AUTH-001` |
| Registry copies are independently re-parsed and semantic-validated before authority record creation | `registry.ts`, `semantic-validator.ts` | `P9-AUTH-001`, `P9-SEM-*` |
| Registration records use bounded stable reads and reject identity tamper | `registry.ts` | `P9-MAINT-005` |
| Registered archive mutation is detected on status read | `registry.ts` | `P9-MAINT-002` |
| Web response envelope is closed-world and exact-artifact/payload/run bound | `response-validator.ts` | `P9-AUTH-006`, `P9-MAINT-004` |
| Compiled Phase 9 CLI exercises registration and registry status | `standalone-cli.ts`, `web-authority-cli.ts` | `CLI-P9-001` |

## Maintainer freeze conditions

Before Phase 9 is used as the base of Phase 10, all of the following must hold on the exact Phase 9 head:

1. `npm run phase9:release-gate` passes.
2. PR remains Draft/open/unmerged.
3. No Phase 9 production path commits, pushes, opens/updates a PR, marks Ready, merges, or applies pack operations.
4. `PHASE9.md`, `ARTIFACT-REGISTRY.md`, `WEB-AUTHORITY-CONTRACT.md`, `SECURITY.md`, `PERFORMANCE.md` and this coverage map describe the same authority boundary.
5. A maintainer audit re-reads the exact diff and challenges registration idempotency, archive/state races, canonical-run binding, Git inventory parsing and stale-spec/preimage behavior.

Phase 10 may consume only the exact frozen Phase 9 head; later Phase 9 fixes require rebasing/retargeting the stacked Phase 10 dependency before that phase can be considered valid.
