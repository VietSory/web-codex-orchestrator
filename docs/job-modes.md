# WCO job modes

WCO has two orchestration boundaries. They preserve the same security and human-merge rules, but differ in who owns the next safe step.

## PAIR — default

PAIR is the existing interactive WCO experience. Plain text goals and `/new <goal>` start PAIR. It keeps the Web implementation-pack closed-world postimage semantics unchanged and never silently turns a free-form task into autonomous execution.

## AUTOPILOT — explicit job ownership

Normal users start AUTOPILOT from the same `wco` shell:

```text
/auto <goal>
```

No Task Bundle, ZIP, run ID, state directory, or internal Node entry point is exposed to the normal user.

WCO creates a mode-tagged pending Web task. The Senior Architect inspects the exact repository and seals the architecture/acceptance contract. In AUTOPILOT it must stop after `contract_sealed`; it does not submit `implementation_sealed` or compete with Codex for implementation authority.

The local worker materializes and prepares the exact Task Bundle internally at contract seal. It intentionally stops event consumption at that point in AUTOPILOT. From the prepared run, the durable driver reuses Phase 4 execution/repair, deterministic verification, Terra review, Sol review, Phase 5 publication/Draft PR, Phase 6 Result Bundle, Web final review, and Phase 8 same-PR revision until APPROVE or a human boundary.

## Mode propagation and authority split

New authoring requests carry `orchestration_mode`; missing mode is PAIR only for backward compatibility. The relay rejects any supplied value other than `PAIR` or `AUTOPILOT`.

- PAIR: Web can seal exact implementation authority.
- AUTOPILOT: Web is architecture/specification authority only until contract seal; Codex/ExecutionService owns implementation and bounded repair afterward.
- Web returns as independent final reviewer in both modes.

## Durable state and recovery

`autopilot.json` records monotonic generation, stage, retry state/deadline, pending review job, review/revision rounds, status and terminal action. Reads reject symlink/path-swap/growth/truncation attacks; writes use run lock plus generation CAS. Restart re-enters idempotent service stages, reuses pending Web review IDs and honors remaining retry deadlines.

The normal TUI turns Ctrl+C during AUTOPILOT into an abort request so the durable driver can checkpoint `PAUSED`. `/run` resumes the same prepared run without exposing its identity.

## Final-review UX

The interactive surface wraps the existing `WebBridge` with a notification-only adapter. Once per exact final-review job it opens the configured Senior Architect GPT when possible. Browser notification failure is never authority and cannot change the exact review/result state.

`READY_FOR_YOU` is re-attested against the live Draft PR head before a merge prompt is returned. `NEEDS_YOU` is reserved for replan/contract conflicts, policy/human boundaries, exhausted bounded resources, Web escalation or non-retryable failures.

A successfully completed local UI session is marked `COMPLETED` so it does not block the next normal goal. This UI terminal marker is not merge authority; durable publication/review receipts remain authoritative.

## Pending relay selection

Pending/status relay surfaces return the newest **non-expired** authoring or final-review job for the authenticated principal. This avoids older unexpired work shadowing a newly-created task. Mode input is validated fail-closed.

## Human-owned actions

Neither mode automatically merges, marks ready, enables auto-merge, deploys, releases, force-pushes or performs destructive Git updates.

## Advanced/headless integration

Normal AUTOPILOT is `/auto <goal>`. The lower-level `dist/orchestration/autopilot-standalone-cli.js` remains available only for operators who already have a prepared run and need deterministic automation/recovery compatibility.

## Hosted-service boundary

Local product flow, protocol, reference relay, managed client, GPT instructions and fail-closed metadata are repository-owned and testable. A stable managed relay/OAuth deployment plus hosted Senior Architect GPT configuration are external deployment operations and require separate real hosted-Web verification; synthetic CI is not that proof.
