# WCO job modes

WCO has two orchestration boundaries. They preserve the same security and human-merge rules, but differ in who owns implementation after the Web architecture handoff.

## Reviewer mode — one reviewer per task

Normal WCO tasks use **exactly one model reviewer** after deterministic verification.

Default:

```text
Sol · high
```

The user can inspect or change the reviewer preference for **new tasks** from the normal `wco` shell:

```text
/mode
/mode sol high
/mode terra medium
/mode terra xhigh
```

Supported reviewer models are Sol and Terra. Supported reasoning efforts are `minimal`, `low`, `medium`, `high`, and `xhigh`.

The selected reviewer is snapshotted when the task starts and frozen to the prepared run at contract seal. Changing the global `/mode` preference later cannot silently switch the reviewer of an in-progress or resumable run.

WCO does not automatically stack Terra review and Sol review. If Sol is selected, only Sol reviews. If Terra is selected, only Terra reviews. A reviewer `REVISE` in AUTOPILOT returns the work to the implementer, then deterministic verification runs again and the **same selected reviewer** reviews the new exact change-set.

## PAIR — default job mode

Plain text goals and `/new <goal>` start PAIR. PAIR keeps the existing Web implementation-pack closed-world postimage semantics unchanged and never silently turns a free-form task into autonomous execution.

Normal PAIR flow:

```text
user goal
→ Web inspects exact repository/base
→ Web seals architecture + exact implementation authority
→ WCO applies the exact authorized change
→ deterministic verification
→ selected reviewer (default Sol/high)
→ publish exact branch
→ open Draft PR
→ bind Result Bundle to exact published/Draft-PR head
→ READY FOR YOU
→ human reviews/merges
```

A selected reviewer rejection does not grant an implementation model authority to rewrite the Web-authorized PAIR patch. WCO stops/escalates safely so the closed-world PAIR authority model remains intact.

## AUTOPILOT — explicit job ownership

Normal users start AUTOPILOT from the same `wco` shell:

```text
/auto <goal>
```

No Task Bundle, ZIP, run ID, state directory, or internal Node entry point is exposed to the normal user.

WCO creates a mode-tagged pending Web task. The Senior Architect inspects the exact repository and seals the architecture/acceptance contract. In AUTOPILOT it must stop after `contract_sealed`; it does not submit `implementation_sealed` or compete with Codex for implementation authority.

The local worker materializes and prepares the exact Task Bundle internally at contract seal and freezes the task's selected reviewer. From the prepared run, the durable driver reuses the repair-capable execution pipeline.

Normal AUTOPILOT flow:

```text
user /auto goal
→ Web inspects exact repository/base and seals the contract
→ Terra/Codex implementer
→ deterministic verification
→ selected reviewer (default Sol/high)
   ├─ REVISE → Terra/Codex repair → verify again → same selected reviewer
   ├─ REPLAN / policy / consequential ambiguity → NEEDS YOU
   └─ APPROVE
→ exact publication
→ open Draft PR
→ exact Result Bundle / Draft-PR-head attestation
→ READY FOR YOU
→ human reviews/merges
```

There is no second automatic reviewer and no normal Web final-review stage after the selected reviewer approves.

## Mode propagation and authority split

New authoring requests carry `orchestration_mode`; missing mode is PAIR only for backward compatibility. The relay rejects any supplied value other than `PAIR` or `AUTOPILOT`.

- PAIR: Web can seal exact implementation authority.
- AUTOPILOT: Web is architecture/specification authority only until contract seal; Codex/ExecutionService owns implementation and bounded repair afterward.
- Selected model reviewer: independent read-only review after deterministic verification; exactly one reviewer per normal task.
- User: final merge authority in both modes.

## Durable state and recovery

`autopilot.json` records monotonic generation, stage, retry state/deadline, status and terminal action. Reads reject symlink/path-swap/growth/truncation attacks; writes use the run lock plus generation CAS. Restart re-enters idempotent service stages and honors remaining retry deadlines.

Reviewer choice is also frozen per run. Resume must use the frozen model and reasoning effort; it must not inherit a newer global `/mode` preference.

The normal TUI turns Ctrl+C during AUTOPILOT into an abort request so the durable driver can checkpoint `PAUSED`. `/run` resumes the same prepared run without exposing its identity.

`READY_FOR_YOU` on the normal single-review AUTOPILOT path re-attests the exact Result Bundle and open Draft PR binding before returning the human merge action.

A successfully completed local UI session is marked `COMPLETED` so it does not block the next normal goal. This UI marker is not merge authority; durable verification, reviewer, publication and Draft-PR/result receipts remain authoritative.

## Legacy Web-final-review compatibility

The previous Web final-review / same-PR Phase 8 revision machinery remains available only as an explicit low-level compatibility path for existing automation. It is **not** part of the normal `wco` PAIR or `/auto` user flow and is not an additional reviewer layer.

Keeping this compatibility path preserves old durable recovery/security coverage without forcing normal users through a second review system.

## Pending relay selection

Pending/status relay surfaces return the newest non-expired task/review relevant to the authenticated principal. Mode input is validated fail-closed. Normal AUTOPILOT authoring becomes terminal at contract seal, so Web cannot submit implementation authority afterward.

## Human-owned actions

Neither mode automatically merges, marks ready, enables auto-merge, deploys, releases, force-pushes or performs destructive Git updates.

## Advanced/headless integration

Normal AUTOPILOT is `/auto <goal>`. The lower-level `dist/orchestration/autopilot-standalone-cli.js` remains available for operators who already have a prepared run and need deterministic automation/recovery compatibility.

## Hosted-service boundary

Local product flow, protocol, reference relay, managed client, GPT instructions and fail-closed metadata are repository-owned and testable. A stable managed relay/OAuth deployment plus hosted Senior Architect GPT configuration are external deployment operations and require separate real hosted-Web verification; synthetic CI is not proof of that external deployment.