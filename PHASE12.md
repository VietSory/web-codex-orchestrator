# Phase 12 — Exact-Head Draft PR Orchestration

## Goal

Phase 12 extends the durable Phase 11 control plane across the first post-publish network boundary. WCO may create or reconcile only an **open Draft pull request** whose head is the exact commit already attested and pushed by the Phase 10/11 publication path. It never marks a pull request ready, merges it, deletes its branch, or relaxes the frozen delivery contract.

## Frozen invariants

1. `OPEN_DRAFT_PR` is a durable transition with the same checkpoint/attempt fencing as earlier external transitions.
2. The current registered Web artifact and `READY_FOR_PUBLISH` executor snapshot are re-attested before the transition is sealed.
3. Draft PR authority requires an executor-scoped Phase 5A receipt in `PUSHED` state with exact run ID, base commit, delivery branch, remote name/URL, change-set digest, and `commit_sha === remote_branch_sha`.
4. GitHub repository identity comes only from the trusted allowed remote. Arbitrary owner/repository input is not accepted by the orchestration adapter.
5. GitHub creation/reconciliation must end at exactly one open Draft PR for the expected head SHA and base branch. A non-Draft, closed, merged, wrong-head, wrong-base, wrong-repository, ambiguous, or mutated candidate fails closed through the existing Phase 5B state machine.
6. The transition completion receipt binds the PR request digest, pull number, expected head SHA and the durable orchestration attempt. A failed/uncertain API result cannot advance to packaging.
7. Snapshot planning reads the executor-scoped durable Draft PR receipt; it does not infer success from a browser tab, CLI transcript, GitHub UI state cached elsewhere, or Codex session history.
8. `PACKAGE_RESULT` remains a boundary for Phase 13. Phase 12 does not smuggle Result Bundle generation into Draft PR creation.
9. Merge, Ready-for-review, branch deletion, force-push and contract mutation remain forbidden.

## Security and recovery

The adapter reuses the hardened Phase 5B Draft PR state machine rather than introducing a second GitHub mutation implementation. Before the network mutation it checks the current Phase 10 READY authority and the exact durable push receipt. HTTPS publish credentials use the existing temporary askpass boundary and are removed in `finally`; GitHub API credentials are read only from the configured environment key and are not written into orchestration state.

Phase 5B already treats an uncertain create response as recoverable: a later attempt lists/re-attests the candidate instead of blindly issuing another POST. Phase 12 places that behavior behind the durable transition lock and attempt budget, preventing concurrent `continue` calls from multiplying create requests.

GitHub's current REST documentation explicitly exposes `draft` on pull-request creation and `maintainer_can_modify` as separate request controls. WCO keeps the request deterministic with `draft: true`, does not add any Ready/merge action, and preserves the frozen no-auto-merge policy.

## Performance, session and token boundaries

Opening a Draft PR is state-driven and does not require a Codex/ChatGPT browser session or model turn. WCO reads bounded durable receipts and reuses the exact Phase 10 attestation rather than replaying implementation/reviewer transcripts. This avoids turning upstream Codex history/resume behavior into control-plane authority.

Recent upstream Codex reports continue to show why this boundary matters: issue #22411 reports expensive global session deserialization on `thread/list`; #30932 and #28866 report extreme memory use resuming very large rollout histories; #25430 reports resume-picker freezes with larger histories. Phase 12 therefore adds no global thread scan, resume picker dependency, browser lifecycle dependency, transcript cache, or token-bearing re-review step. These are compatibility constraints only; WCO does not modify Codex app/CLI/agent internals.

## Tests

`tests/phase12-post-publish-orchestration.test.ts` covers:

- exactly one sealed `OPEN_DRAFT_PR` transition advancing to `PACKAGE_RESULT` only after an exact open Draft receipt;
- fail-closed behavior for a non-Draft/mismatched result;
- the Phase 13 packaging boundary so repeated `continue` calls do not recreate the PR.

The existing Phase 5B suites remain the detailed GitHub API/state-machine regression coverage and are also exercised by the full unit gate.

## Release gate

```text
npm run phase12:release-gate
```

The gate includes typecheck, frozen Phase 9/10/11 suites, Phase 12 regressions, the complete unit/fake suite, Phase 8 E2E, build and compiled CLI integration. Native Windows/WSL Git/Codex authentication and real-account GitHub behavior remain local compatibility checks and are not claimed by deterministic GitHub CI.
