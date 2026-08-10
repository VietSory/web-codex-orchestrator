# WCO job modes

WCO has two orchestration boundaries. They share the same secure execution, verification, review, publication, Draft PR, and Web review primitives. The difference is who owns the next safe step.

## PAIR — default

PAIR is the existing interactive WCO experience. The user and Web Architect collaborate on intent and task authoring, and the TUI remains the normal control surface.

PAIR must never silently turn a free-form task into a fully autonomous background workflow. Existing onboarding, Web connection prompts, progress language, `/status`, `/review`, `/pause`, `/resume`, and other TUI behavior remain unchanged.

Use PAIR when the user expects to stay in the loop or may change direction while the task is being shaped.

## AUTOPILOT — explicit job ownership

AUTOPILOT starts only after WCO has an exact prepared run and a sealed Web implementation pack. It does not replace Web authoring authority and it does not invent a task contract locally.

After that handoff, the durable AUTOPILOT driver owns the safe continuation loop:

1. register the exact Web implementation pack;
2. execute the existing deterministic implementation/repair pipeline;
3. require deterministic verification;
4. require independent Terra and Sol approval of the same change-set digest;
5. publish the verified change through the existing publisher;
6. open an exact Draft PR;
7. package the exact Result Bundle;
8. request Web final review;
9. adopt an exact Web verdict;
10. if revision is requested, reuse the existing revision/verification/review pipeline and request Web review again;
11. stop at a human boundary.

No separate implementation, verifier, reviewer, Git publisher, PR client, revision engine, retry framework, or Web verdict processor is introduced for AUTOPILOT. The driver composes the existing WCO primitives.

## Durable state and recovery

AUTOPILOT writes `autopilot.json` inside the canonical run directory. The receipt binds the run ID, exact Web pack path, pending Web review job, review-round count, latest transition, status, and terminal action.

Waiting is not progress. Web polling and retry/backoff waiting do not consume AUTOPILOT progressing-cycle budget. The existing orchestration ledger, retry policy, circuit breaker, model/token budgets, and transition attempt limits remain authoritative for repeated failures.

An interrupted job records `PAUSED` and can be driven again from durable WCO state. Browser/model conversation history is never recovery authority.

## User boundaries

`READY_FOR_YOU` means the exact Draft PR head has passed the required review boundary and WCO may ask the user to merge. WCO still does not merge it.

`NEEDS_YOU` is reserved for boundaries that should not be guessed through, including:

- Web or reviewer escalation;
- a replan that requires a fresh Web implementation pack;
- a terminal policy or operational block;
- exhausted bounded execution resources;
- another consequential decision that existing WCO policy assigns to a human.

If Web authority asks for a new implementation pack after replan, AUTOPILOT must not replay the previous pack.

## Human-owned actions

Both modes preserve the same hard boundary: WCO does not automatically merge, mark a PR ready, enable auto-merge, deploy, publish a release, or perform destructive Git updates.

## Headless integration

The AUTOPILOT driver is available as `src/orchestration/autopilot-job.ts`. The repository also builds `dist/orchestration/autopilot-standalone-cli.js` for headless automation integration without changing the default `wco` TUI.

From a built checkout, the advanced entry point is:

```text
node dist/orchestration/autopilot-standalone-cli.js \
  --run-id <task-id:sha256> \
  --web-pack <exact-web-pack.zip> \
  --state-dir <state-directory> \
  --config <config.json>
```

This advanced entry point is intentionally separate from the default interactive UX while the AUTOPILOT product surface is validated.
