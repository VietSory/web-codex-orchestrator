# WCO job modes

WCO has two orchestration boundaries. They preserve the same security and human-merge rules, but differ in who owns implementation after the Web architecture handoff.

## Review pipeline — one code reviewer plus Web final review

Normal WCO tasks use **exactly one model/code reviewer** after deterministic verification, followed by an **independent ChatGPT Web final review** before `READY_FOR_YOU`.

Default code reviewer:

```text
Sol · high
```

The user can inspect or change the code-review preference for **new tasks** from the normal `wco` shell:

```text
/mode
/mode sol high
/mode terra medium
/mode terra xhigh
```

Supported code-review models are Sol and Terra. Supported reasoning efforts are `minimal`, `low`, `medium`, `high`, and `xhigh`.

The selected code reviewer is snapshotted when the task starts and frozen to the prepared run at contract seal. Changing the global `/mode` preference later cannot silently switch the reviewer of an in-progress or resumable run. `/mode` does not disable or replace ChatGPT Web final review.

WCO does not automatically stack Terra review and Sol review. If Sol is selected, only Sol performs the code-review stage. If Terra is selected, only Terra performs it. A code-review `REVISE` in AUTOPILOT returns the work to the implementer, then deterministic verification runs again and the **same selected code reviewer** reviews the new exact change-set.

After code review approves, WCO publishes the exact reviewed head, creates/attests the Draft PR and Result Bundle, and sends that exact evidence to ChatGPT Web for final review. Web is the second review stage, but it has a different responsibility: verify end-to-end user intent, architecture/contract compliance, acceptance evidence, actual diff/result, and the exact Draft PR head.

If Web requests a revision, Phase 8 performs bounded same-PR repair, deterministic verification, and the **same frozen code reviewer** again before a new Result Bundle is sent back to Web. Only Web `APPROVED` on a freshly attested exact Draft PR head can lead to `READY_FOR_YOU`.

## PAIR — default job mode

Plain text goals and `/new <goal>` start PAIR. PAIR keeps the existing Web implementation-pack closed-world postimage semantics unchanged and never silently turns a free-form task into autonomous execution.

Normal PAIR flow:

```text
user goal
→ Web inspects exact repository/base
→ Web seals architecture + exact implementation authority
→ WCO applies the exact authorized change
→ deterministic verification
→ selected code reviewer (default Sol/high)
→ publish exact branch
→ open Draft PR
→ bind Result Bundle to exact published/Draft-PR head
→ ChatGPT Web final review
   ├─ REVISION_REQUESTED → sealed same-PR revision → verify → same selected reviewer → Web again
   ├─ ESCALATED → NEEDS YOU
   └─ APPROVED
→ READY FOR YOU
→ human reviews/merges
```

A selected code-review rejection before Web revision authority exists does not grant an implementation model authority to rewrite the Web-authorized PAIR patch. WCO stops/escalates safely so the closed-world PAIR authority model remains intact. After Web seals a `REVISION_REQUESTED` verdict, Phase 8 has explicit bounded authority to repair only the sealed findings, then re-verifies and re-runs the same selected reviewer before returning to Web.

## AUTOPILOT — explicit job ownership

Normal users start AUTOPILOT from the same `wco` shell:

```text
/auto <goal>
```

No Task Bundle, ZIP, run ID, state directory, or internal Node entry point is exposed to the normal user.

WCO creates a mode-tagged pending Web task. The Senior Architect inspects the exact repository and seals the architecture/acceptance contract. In AUTOPILOT it must stop after `contract_sealed`; it does not submit `implementation_sealed` or compete with Codex for implementation authority.

The local worker materializes and prepares the exact Task Bundle internally at contract seal and freezes the task's selected code reviewer. From the prepared run, the durable driver reuses the repair-capable execution pipeline.

Normal AUTOPILOT flow:

```text
user /auto goal
→ Web inspects exact repository/base and seals the contract
→ Terra/Codex implementer
→ deterministic verification
→ selected code reviewer (default Sol/high)
   ├─ REVISE → Terra/Codex repair → verify again → same selected code reviewer
   ├─ REPLAN / policy / consequential ambiguity → NEEDS YOU
   └─ APPROVE
→ exact publication
→ open Draft PR
→ exact Result Bundle / Draft-PR-head attestation
→ ChatGPT Web final review
   ├─ REVISION_REQUESTED → same-PR repair → verify → same selected code reviewer → updated Result Bundle → Web again
   ├─ ESCALATED → NEEDS YOU
   └─ APPROVED
→ READY FOR YOU
→ human reviews/merges
```

This is intentionally a **two-stage review pipeline**: one selected model reviewer for code-level quality plus one independent Web final review for intent/architecture/end-to-end quality. It is not the redundant three-review chain Terra → Sol → Web.

## Mode propagation and authority split

New authoring requests carry `orchestration_mode`; missing mode is PAIR only for backward compatibility. The relay rejects any supplied value other than `PAIR` or `AUTOPILOT`.

- PAIR: Web can seal exact implementation authority.
- AUTOPILOT: Web is architecture/specification authority only until contract seal; Codex/ExecutionService owns implementation and bounded repair afterward.
- Selected model reviewer: independent read-only code review after deterministic verification; exactly one model reviewer per review round.
- ChatGPT Web final reviewer: independent final decision over the exact Result Bundle and freshly attested Draft PR head.
- User: final merge authority in both modes.

## Durable state and recovery

`autopilot.json` records monotonic generation, stage, retry state/deadline, pending Web review job identity, Web-review/revision rounds, status and terminal action. Reads reject symlink/path-swap/growth/truncation attacks; writes use the run lock plus generation CAS. Restart re-enters idempotent service stages and honors remaining retry deadlines.

Reviewer choice is also frozen per run. Resume and Phase 8 revision must use the frozen model and reasoning effort; they must not inherit a newer global `/mode` preference.

The normal TUI turns Ctrl+C during AUTOPILOT into an abort request so the durable driver can checkpoint `PAUSED`. `/run` resumes the same prepared run without exposing its identity. If interruption happened while waiting for Web, WCO reuses the durable pending review job rather than creating a duplicate.

`READY_FOR_YOU` always requires at least one adopted Web final-review round. Every later READY read re-attests the Web approval against the current exact Draft PR head; Result Bundle attestation alone cannot substitute for Web approval.

A successfully completed local UI session is marked `COMPLETED` so it does not block the next normal goal. This UI marker is not merge authority; durable verification, selected-reviewer, publication, Result Bundle and Web-review receipts remain authoritative.

## Pending relay selection

Pending/status relay surfaces return the newest non-expired task/review relevant to the authenticated principal. Mode input is validated fail-closed. Normal AUTOPILOT authoring becomes terminal at contract seal, so Web cannot submit implementation authority afterward. Final-review transport remains exact-bound to review ID, run ID and Result Bundle identity with single-terminal-verdict/idempotent-replay semantics.

## Human-owned actions

Neither mode automatically merges, marks ready, enables auto-merge, deploys, releases, force-pushes or performs destructive Git updates.

## Advanced/headless integration

Normal AUTOPILOT is `/auto <goal>`. The lower-level `dist/orchestration/autopilot-standalone-cli.js` remains available for operators who already have a prepared run and need deterministic automation/recovery. It uses the same mandatory Web final-review requirement before `READY_FOR_YOU`.

## Hosted-service boundary

Local product flow, protocol, reference relay, managed client, GPT instructions and fail-closed metadata are repository-owned and testable. A stable managed relay/OAuth deployment plus hosted Senior Architect GPT configuration are external deployment operations and require separate real hosted-Web verification; synthetic CI is not proof of that external deployment.
