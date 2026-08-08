# Web Codex Orchestrator

WCO turns Web-authored software work into **registered, constrained, independently verified and durably orchestrated local changes**. Web authority supplies exact implementation/revision inputs; WCO owns durable lifecycle state, applies only registered authority, verifies exact changes, publishes evidence to one Draft PR and never treats browser/session/model output as merge authority.

> Current stacked development status: Phase 9 through Phase 15 are implemented on stacked branches with exact-head CI evidence. Phase 16 final hardening is the active Draft PR. No Phase 9–16 work requires merging `main` to continue.

## Trust and lifecycle model

```text
Web Authority registered implementation pack
  → exact constrained application
  → deterministic verification
  → independent Terra review
  → independent Sol review
  → normal commit + fast-forward push
  → one Draft Pull Request
  → verified Result Bundle
  → explicit Web verdict
       APPROVE / ESCALATE → WAIT_HUMAN
       REVISE → bounded same-PR Phase 8 revision
                → next verified Result Bundle
                → explicit next Web verdict
```

Hard boundaries:

- loose chat text, loose patches, browser state and transcripts are never implementation authority;
- downloaded archives remain untrusted until validated/registered;
- Phase 10 has no redundant local implementer turn: exact registered Web bytes are applied and reviewed;
- reviewers are independent, read-only/no-network and bind the exact change-set digest;
- revision authority comes only from the sealed Web Review receipt/request chain;
- publication is normal fast-forward only: no amend/rebase/force-push;
- WCO never marks a PR Ready, enables auto-merge, deletes the delivery branch or merges `main`;
- merge remains a human decision.

See `SECURITY.md`, `WEB-AUTHORITY-CONTRACT.md`, `ARTIFACT-REGISTRY.md`, `PERFORMANCE.md`, `UPSTREAM-COMPATIBILITY.md` and `PHASE9.md` through `PHASE16.md`.

## Requirements

- Node.js 20+
- Git
- npm
- for real Codex verification/review: the WCO-pinned Codex runtime and authenticated local Codex state

Normal GitHub CI uses fake model/sandbox adapters and consumes no Codex quota.

## Install and final GitHub-verifiable gate

```bash
npm ci
npm run phase16:release-gate
```

The final gate includes typecheck, Phase 13–16 focused regressions, the complete unit/fake suite, Phase 8 fake end-to-end, build and compiled CLI integration tests. GitHub CI independently runs the repository-wide gate on each PR head.

## Durable control plane

Read-only operations:

```bash
wco-control status --run-id <task-id>:<sha256> --state-dir <state-dir> --json
wco-control next --run-id <task-id>:<sha256> --state-dir <state-dir> --json
wco-control doctor --run-id <task-id>:<sha256> --state-dir <state-dir> --config <config.json> --json
```

Bounded continuation:

```bash
wco-control continue \
  --run-id <task-id>:<sha256> \
  --state-dir <state-dir> \
  --config <config.json> \
  [--web-pack <registered-web-pack.zip>] \
  [--web-verdict <verdict.json>] \
  [--max-transitions <1..32>] \
  --json
```

`continue` advances only transitions whose authority is already present. Missing Web pack/verdict is an input wait, not a failed retry. `WAIT_HUMAN` is terminal for autonomous operation. Pause/resume, retry backoff, transition locks, bounded budgets and recovery receipts survive process restart.

Lower-level Phase 4–10 commands remain explicit diagnostic/recovery surfaces, including `wco execute`, `wco publish`, `wco create-draft-pr`, `wco package-result`, `wco submit-web-verdict`, `wco revise`, `wco-web-authority` and `wco-executor`.

## Performance, resource and token discipline

`PERFORMANCE.md` is normative. The implementation uses content-addressed project/repository evidence, progressive/bounded context, bounded worker pools and backpressure, compacted durable event/diagnostic state, bounded subprocess output, typed retry/circuit behavior, and model/token budgets. Status paths do not start model work or scan whole Codex/browser histories.

WCO treats browser/Codex session history as transport/cache state. Public upstream reports of large-history resume CPU/RAM problems, resume-picker freezes, persistence failures and configuration drift are converted into negative requirements: WCO reconstructs authority from its own bounded content-addressed receipts/maps, re-attests trusted model/config bindings and surfaces durability failures. It does not fork or patch OpenAI Codex internals. See `UPSTREAM-COMPATIBILITY.md` and `PHASE16.md`.

## Security and recovery summary

- state/worktree/registry paths are confinement- and symlink-aware;
- sensitive/untrusted reads are bounded and re-attest file identity/size;
- selected Web authority and execution/review evidence are hash-bound;
- crash recovery adopts only exact registered/attested lower-layer states;
- stale/late results cannot complete a newer attempt;
- GitHub head/Draft/PR identity is freshly attested at publication/review boundaries;
- same-PR revision reuses the frozen accepted bundle and original path/verification/reviewer policy;
- diagnostics/log tails are bounded and secrets are excluded from result archives.

## Local-only final checks

GitHub CI cannot prove native Windows/WSL/Codex/bridge behavior. After the exact Phase 16 head and both maintainer audits pass, the only remaining verification is `LOCAL-FINAL-CHECKLIST.md`.
