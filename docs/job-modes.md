# WCO job modes

WCO has two orchestration boundaries. They preserve the same security and human-merge rules, but differ in who owns the next safe step.

## PAIR — default

PAIR is the existing interactive WCO experience. The user and Web Architect collaborate on intent and implementation authoring, and the current TUI remains the normal control surface.

PAIR must never silently turn a free-form task into autonomous execution. Existing onboarding, Web connection prompts, progress language, `/status`, `/review`, `/pause`, `/resume`, and other TUI behavior remain unchanged.

## AUTOPILOT — explicit job ownership

AUTOPILOT starts from an exact **prepared Task Bundle run**. Web remains the architecture/specification authority; Codex owns implementation and bounded repair after that sealed handoff.

The durable driver composes existing WCO services rather than replacing them:

1. run the existing Phase 4 `ExecutionService`;
   - Terra implements;
   - deterministic verification runs;
   - verifier failures feed bounded evidence back to Terra;
   - Terra review `REVISE` feeds blocking findings back to Terra;
   - Sol review `REVISE` feeds blocking findings back to Terra;
   - every correction is re-verified and independently re-reviewed;
   - only one exact change-set digest approved by verification, Terra, and Sol becomes publishable;
2. reuse Phase 5A to publish the verified digest;
3. reuse Phase 5B to open/attest an exact Draft PR;
4. reuse Phase 6 to build and verify the Result Bundle;
5. send that exact result to Web final review;
6. if Web requests revision, reuse the existing Phase 8 same-PR revision service, including its own Terra fix → verify → Terra review → Sol review loop;
7. send the revised Result Bundle back to Web;
8. repeat until Web approves or an explicit human boundary is reached;
9. stop at `READY_FOR_YOU` and ask the user to merge.

No second implementation engine, verifier, reviewer, Git publisher, PR client, revision engine, or Web-verdict processor is introduced for AUTOPILOT.

## Why AUTOPILOT does not reuse the PAIR Web-pack executor

PAIR's current Web implementation-pack path deliberately enforces closed-world postimages: the published files must exactly match the registered Web operations. Allowing a local repair agent to edit that path would weaken the authority invariant.

AUTOPILOT therefore reuses the already-existing Task Bundle execution pipeline that was designed for Codex implementation and repair, while PAIR keeps its exact Web-pack semantics unchanged.

## Durable state and recovery

AUTOPILOT writes `autopilot.json` inside the canonical run directory. It records the run ID, current service stage, per-stage transient retry count, pending Web review job ID, Web review rounds, revision rounds, status, and terminal action.

Each underlying WCO service also keeps its own durable receipt. A process restart therefore re-enters the same idempotent service stage instead of trusting browser/model conversation history. If the job was waiting for Web, the pending review job ID is reused rather than creating a duplicate review.

Waiting is not progress. Web polling and transient retry/backoff do not consume completed-stage budget. Transient failures reuse WCO's existing retry classifier and deterministic exponential-backoff calculation; policy, replan, human-action, and exhausted-budget boundaries fail closed to `NEEDS_YOU`.

## User boundaries

`READY_FOR_YOU` means the exact Draft PR head has passed Web final review. WCO may ask the user to merge, but never merges it.

`NEEDS_YOU` is reserved for boundaries that should not be guessed through, including replan/contract conflicts, explicit human action, policy blocks, exhausted bounded execution resources, Web escalation, or non-retryable operational failures.

## Human-owned actions

Both modes preserve the same hard boundary: WCO does not automatically merge, mark a PR ready, enable auto-merge, deploy, publish a release, or perform destructive Git updates.

## Headless integration

The AUTOPILOT driver is `src/orchestration/autopilot-job.ts`. The build also emits `dist/orchestration/autopilot-standalone-cli.js` without changing the default `wco` TUI.

Prepare the Task Bundle through the existing trusted preparation flow, then drive that exact run:

```text
node dist/orchestration/autopilot-standalone-cli.js \
  --run-id <prepared-task-id:archive-sha256> \
  --state-dir <state-directory> \
  --config <config.json>
```

This advanced entry point remains separate from the optimized interactive UX while the AUTOPILOT product surface is validated.
