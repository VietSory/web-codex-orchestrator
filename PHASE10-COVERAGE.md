# Phase 10 Coverage — Code-First Constrained Executor

Phase 10 is complete only when exact registered Web bytes are the only implementation authority and every model/tool gate is observational rather than a source of unregistered code.

## Release gate

```bash
npm run phase10:release-gate
```

The gate includes Phase 9 authority regressions, targeted Phase 10 transaction/service/adversarial tests, the complete unit/fake suite, Phase 8 end-to-end regression, production build, and compiled CLI integrations.

## Boundary matrix

| Invariant | Production boundary | Executable evidence |
| --- | --- | --- |
| Only a valid Phase 9 registration/archive can start fresh execution | `source.ts`, Phase 9 registry | `P10-SVC-001`, Phase 9 authority tests |
| Fresh execution re-runs canonical P9/run/tree/spec/preimage authority before first write | `source.ts`, shared `task-spec-authority.ts` | `P10-SVC-001`, Phase 9 stale-spec/preimage tests |
| Every operation preimage and backup is proven before the first product write | `applier.ts` | `P10-APPLY-001`, `P10-APPLY-002` |
| State/backups/evidence are bounded, no-follow and state-root confined | `state-io.ts`, `store.ts`, `applier.ts`, `evidence-store.ts` | `P10-MAINT-002..004` |
| Crash recovery accepts only exact registered preimage/postimage states | `applier.ts` | `P10-APPLY-003`, `P10-APPLY-004` |
| Crash resume rejects unregistered changed paths before continuing product writes | `change-set.ts`, `service.ts` | `P10-MAINT-001` |
| Persisted transaction is rebound to the exact registered Phase 9 operation/payload set | `transaction-authority.ts`, `service.ts` | `P10-MAINT-006` |
| Apply consumes exact payload bytes and never executes payload entries | `applier.ts`, `worktree-io.ts` | `P10-APPLY-001` |
| Changed-path set after apply equals registered operation set exactly | `change-set.ts` | `P10-SVC-003`, `P10-SVC-004` |
| Exact approval identity binds postimage bytes **and permission modes** | `change-set.ts` | `P10-MAINT-005` |
| Verification is deterministic/sandboxed and mutation invalidates the gate | `production-gates.ts`, `service.ts` | `P10-SVC-003` plus existing verifier sandbox suites |
| Terra/Sol are read-only reviewers of one exact digest; local correction is forbidden | `production-gates.ts`, `service.ts` | `P10-SVC-002`, `P10-SVC-004` plus existing Terra/Sol read-only tests |
| Persisted gate claims require the exact bounded evidence files they reference | `evidence-store.ts`, `store.ts`, `service.ts` | `P10-MAINT-007` |
| READY requires verification → Terra → Sol approvals chained to one exact digest | `store.ts`, `service.ts` | service/terminal tests + receipt validation |
| Reviewer context is selective/capped rather than an implementation transcript | `production-gates.ts` | prompt-size guard; static maintainer audit |
| Production verifier reads only the accepted `validation.json` needed for deterministic verification | `production-gates.ts`, shared authority reader | typecheck/unit regression + static audit |
| Runtime/auth/sandbox availability is checked before product mutation | `executor-cli.ts`, `production-gates.ts` | `CLI-P10-002` plus existing runtime/sandbox tests |
| Terminal READY retry re-attests transaction/evidence/exact digest instead of trusting stale success | `service.ts` | `P10-SVC-005`, `P10-MAINT-005..007` |
| Compiled status is read-only and bounded | `executor-cli.ts`, `store.ts` | `CLI-P10-001` |
| Phase 10 never commits, pushes, opens/updates PRs, marks Ready or merges | entire `src/executor/**` production diff | forbidden-capability maintainer audit |

## Performance / token / UX evidence

Phase 10 deliberately removes a redundant implementation-model turn: deterministic WCO code applies the Web-authored bytes, while model usage is limited to two independent read-only reviewers after deterministic verification.

Implemented performance/UX behavior:

- missing registration fails before Codex runtime preflight;
- status reads do not initialize Codex/network/verification;
- production verification reads only bounded `validation.json`, not the whole accepted-bundle document set;
- reviewer prompt is capped and contains digest + changed paths + accepted Task Bundle pointer rather than previous chat/implementation transcript;
- verifier evidence retains bounded command tails rather than whole stdout/stderr;
- model usage exposed by the runtime is included in bounded review evidence;
- Phase 9 and Phase 10 share one accepted-task spec hashing/reader implementation instead of duplicating security-critical I/O;
- normal CI runs the per-file bounded unit runner once instead of duplicating old P9 tests on every commit; phase release gates still run targeted suites before freeze.

## Freeze criteria

Before Phase 10 becomes the dependency base for Phase 11:

1. exact stacked head is based on frozen P9 SHA `a62270d3de783985ad1ec4a6fa3b0e96ba86aaf8`;
2. `npm run phase10:release-gate` components are green on that exact head;
3. PR remains Draft/open/unmerged;
4. no duplicate production executor service remains;
5. `PHASE10.md`, this coverage file, `SECURITY.md`, `PERFORMANCE.md`, `UPSTREAM-COMPATIBILITY.md` and README describe the same boundary;
6. maintainer audit challenges state symlinks, partial writes, transaction tamper, changed-path/mode drift, stale/missing gate evidence, runtime preflight order and forbidden Git/GitHub capabilities;
7. no known merge-blocking Phase 10 contract violation remains.
