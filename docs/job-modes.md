# WCO job modes

WCO exposes two normal modes with the same security boundary: **Web authors bounded implementation authority, Harness owns mutation, deterministic verification is mandatory, original ChatGPT Web performs final intent review, and merge/release remain human-only.**

The modes differ at the code-review stage.

## PAIR — default, zero Codex requirement

Plain goals and `/new <goal>` start PAIR.

```text
user goal
→ original ChatGPT Web inspects/researches exact repository
→ Web seals contract + exact bounded implementation authority
→ Harness validates/applies exact operations
→ deterministic verification in provider-independent sandbox
→ independent Web code review
   ├─ APPROVE
   ├─ REVISE + bounded repair authority → Harness apply/re-verify
   └─ consequential/policy boundary → NEEDS YOU
→ original ChatGPT Web final intent review
→ READY FOR YOU
→ human review/merge
```

PAIR does **not** select, initialize or charge a Sol/Terra reviewer. PAIR readiness must not require Codex CLI/runtime/auth. Deterministic verification uses the provider-independent sandbox and fails closed when its isolation guarantees are unavailable.

Independent Web code review is separate from the original-Web final intent review. A code-review approval checks code-level correctness/security/regression/tests/scope/performance; the final review checks the exact published result against original user intent, architecture and acceptance evidence.

A PAIR revision must remain Web-owned + Harness-applied. Legacy Codex Phase 8 is not a permitted fallback for PAIR.

## AUTOPILOT — Harness-first with one adaptive model review pass

Normal users start AUTOPILOT from the same shell:

```text
/auto <goal>
```

No Task Bundle, ZIP, run ID, state directory or internal Node entry point is exposed to the normal user.

```text
user /auto goal
→ original ChatGPT Web inspects/researches exact repository
→ Web seals contract + exact bounded implementation authority
→ Harness validates/applies exact operations
→ deterministic verification
→ exactly ONE selected Sol/Terra reviewer (default Sol/high)
   ├─ APPROVE
   ├─ REVISE + bounded repair operations in the same review pass
   │    → Harness validates preimage/path/postimage authority
   │    → Harness applies
   │    → deterministic verification
   └─ consequential/policy/replan boundary → NEEDS YOU
→ exact publication / Draft PR / Result Bundle
→ original ChatGPT Web mandatory final intent review
→ READY FOR YOU
→ human review/merge
```

AUTOPILOT is not a Codex-implementer pipeline. The Web author supplies the initial bounded implementation pack; the selected model is reviewer/repair proposer only. It never receives direct worktree-write or shell mutation authority.

The reviewer preference for new AUTOPILOT tasks is controlled from the normal shell:

```text
/mode
/mode sol high
/mode terra medium
/mode terra xhigh
```

Supported reviewers are Sol and Terra. Supported reasoning efforts are `minimal`, `low`, `medium`, `high`, and `xhigh`. The selection is frozen per run so resume/recovery cannot silently inherit a newer global preference.

## Review pipeline

PAIR:

```text
deterministic verification
→ independent Web code review
→ original-Web final intent review
```

AUTOPILOT:

```text
deterministic verification
→ one selected Sol/Terra adaptive code-review pass
→ original-Web final intent review
```

WCO does not stack Terra → Sol → Web. AUTOPILOT uses exactly one selected model reviewer per model-review pass. PAIR uses zero model-review turns.

## Bounded repair authority

Reviewers do not mutate repositories directly.

A bounded repair proposal is limited to exact `create_file`, `replace_file` or `delete_file` operations. Harness validates:

- allowed path scope;
- exact current preimage;
- canonical postimage bytes + SHA-256;
- symlink/path containment rules;
- durable repair identity/checkpoint;
- exact final changed-path set;
- deterministic verification of the repaired digest.

For AUTOPILOT, `REVISE` should include the bounded repair proposal in the same selected reviewer call so WCO avoids review → repair → re-review chatter when the repair itself can be verified deterministically.

For PAIR, independent Web `REVISE` must eventually carry equivalent bounded repair authority. Until that transport is fully wired, WCO fails closed rather than falling back to Codex and violating the zero-Codex guarantee.

## Final-review revision boundary

The original Web final review is mandatory in both modes. It is bound to the exact Result Bundle and freshly attested Draft PR head.

A final-review `REVISION_REQUESTED` must remain a bounded same-PR fast-forward revision. Repair ownership remains mode-specific:

- PAIR: Web-proposed, Harness-applied, zero Codex fallback.
- AUTOPILOT: selected-reviewer-proposed, Harness-applied.

After repair, deterministic verification must bind the new exact digest before a new Result Bundle is reviewed again by the original Web.

## Mode-aware doctor/readiness

`wco doctor` defaults to PAIR readiness. `wco doctor --mode AUTOPILOT` adds Codex reviewer runtime/auth probes.

PAIR readiness requires provider-independent verification isolation, Git/GitHub publication prerequisites and Web connectivity; it must not fail merely because Codex runtime/auth is absent.

AUTOPILOT requires all common prerequisites plus the selected model review runtime/auth.

## Durable state and recovery

Harness mutation/authority transitions are serialized and persisted before side effects. Independent reads, evidence collection and safe attestations may run concurrently where they cannot race authority changes.

Recovery principles:

- exact artifact and run identity are create-once/frozen;
- ambiguous model calls are not replayed automatically;
- bounded repair checkpoints are durable before mutation;
- apply is resumable/idempotent against exact preimage/postimage classification;
- deterministic verification binds the exact effective digest;
- publication and Draft PR receipts bind exact Git heads;
- stale Web review approval is rejected after Result Bundle/head movement;
- READY is re-attested rather than trusted from a cached UI state.

## Performance policy

WCO optimizes latency/token cost by reducing model round trips rather than weakening verification:

- PAIR: zero Codex model turns by design;
- AUTOPILOT: one selected model review pass by default;
- adaptive `REVISE` returns bounded repair operations in the same pass when possible;
- deterministic context selection sends changed files + dependency hints rather than whole-repo context by default;
- independent reads/research may run concurrently, while mutation/authority transitions remain serialized;
- Harness verification/publish reuse exact durable receipts instead of repeating model work.

## Human-owned actions

Neither mode automatically merges, marks a PR ready, enables auto-merge, force-pushes, pushes protected branches directly, deploys, releases, publishes packages or deletes remote branches.

`READY_FOR_YOU` means the exact Draft PR head passed WCO's required gates and is ready for human review/merge. It is not merge authority.

## Hosted-service boundary

Local product flow, protocol, reference relay, managed client, GPT instructions and fail-closed metadata are repository-owned and testable. A stable managed relay/OAuth deployment, hosted Senior Architect GPT configuration and real provider/hosted-Web end-to-end acceptance remain external runtime gates; synthetic CI is not proof of those external systems.
