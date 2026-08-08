# Phase 10 Coverage — Code-First Constrained Executor

Phase 10 is complete only when the exact registered Web bytes are the only implementation authority and every model/tool gate is observational rather than a source of unregistered code.

## Release gate

```bash
npm run phase10:release-gate
```

The gate includes Phase 9 regressions, targeted Phase 10 transaction/service/adversarial tests, the complete unit/fake suite, Phase 8 end-to-end regression, production build, and compiled CLI integrations.

## Boundary matrix

| Invariant | Production boundary | Executable evidence |
| --- | --- | --- |
| Only a valid Phase 9 registration/archive can start fresh execution | `source.ts`, Phase 9 registry | `P10-SVC-001`, Phase 9 authority tests |
| Fresh execution re-runs canonical P9/run/tree/spec/preimage authority before first write | `source.ts` | `P10-SVC-001`, Phase 9 stale-spec/preimage tests |
| Every operation preimage and backup is proven before the first product write | `applier.ts` | `P10-APPLY-001`, `P10-APPLY-002` |
| State/backups/evidence are bounded, no-follow and state-root confined | `state-io.ts`, `store.ts`, `applier.ts`, `evidence-store.ts` | `P10-MAINT-002..004` |
| Crash recovery accepts only exact registered preimage/postimage states | `applier.ts` | `P10-APPLY-003`, `P10-APPLY-004` |
| Crash resume rejects unregistered changed paths before continuing product writes | `change-set.ts`, `service.ts` | `P10-MAINT-001` |
| Apply consumes exact payload bytes and never executes payload entries | `applier.ts`, `worktree-io.ts` | `P10-APPLY-001` |
| Changed-path set after apply equals registered operation set exactly | `change-set.ts` | `P10-SVC-003`, `P10-SVC-004` |
| Verification is deterministic/sandboxed and mutation invalidates the gate | `production-gates.ts`, `service.ts` | `P10-SVC-003` plus existing verifier sandbox suites |
| Terra/Sol are read-only reviewers of one exact digest; local correction is forbidden | `production-gates.ts`, `service.ts` | `P10-SVC-002`, `P10-SVC-004` plus existing Terra/Sol read-only tests |
| Reviewer context is selective and capped rather than a full implementation transcript | `production-gates.ts` | prompt-size guard + exact changed-path request; static maintainer audit |
| Runtime/auth/sandbox availability is checked before product mutation | `executor-cli.ts`, `production-gates.ts` | `CLI-P10-002` plus existing runtime/sandbox tests |
| Terminal READY retry re-attests exact digest rather than trusting stale success | `service.ts` | service regression required before freeze |
| Compiled status is read-only and bounded | `executor-cli.ts`, `store.ts` | `CLI-P10-001` |
| Phase 10 never commits, pushes, opens/updates PRs, marks Ready or merges | entire `src/executor/**` production diff | forbidden-capability static maintainer audit |

## Performance / token / UX requirements

- Exact Web-authored payload bytes are applied by deterministic code; there is no implementer-model turn in Phase 10.
- Reviewer prompts contain the exact digest and changed-path list plus pointers to the accepted Task Bundle, not previous chat/implementation transcripts.
- Model usage counters exposed by the runtime are persisted inside bounded reviewer evidence for later mission telemetry.
- Codex agent auth and verifier sandbox are preflighted once per production executor invocation before product mutation. Phase 11 may cache healthy capability results with a bounded TTL; cache state is never authority.
- Missing registration/argument errors are reported before expensive Codex preflight.
- Status is read-only and does not invoke Codex, GitHub, network, or verification.

These choices follow the project-wide `PERFORMANCE.md` policy: progressive disclosure, content-addressed reuse, bounded concurrency, observable expensive operations, and no duplicate context by default.

## Freeze criteria

Before Phase 10 becomes the dependency base for Phase 11:

1. `npm run phase10:release-gate` passes on the exact stacked head.
2. PR remains Draft/open/unmerged and is based on the exact frozen Phase 9 head.
3. No duplicate production executor service remains.
4. `PHASE10.md`, this coverage file, `SECURITY.md`, `PERFORMANCE.md`, README and code describe the same boundary.
5. Maintainer audit challenges state symlinks, crash windows, backup/evidence tamper, registered/unregistered path races, stale gate digests, runtime preflight order and forbidden Git/GitHub capabilities.
