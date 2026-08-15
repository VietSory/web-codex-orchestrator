# WCO job modes

WCO exposes two normal modes with the same security boundary: **Web authors bounded implementation authority, Harness owns mutation, deterministic verification is mandatory, original ChatGPT Web performs final intent review, and merge/release remain human-only.**

The modes differ only at the code-review stage.

## PAIR — default, zero Codex requirement

Plain goals and `/new <goal>` start PAIR.

```text
user goal
→ original ChatGPT Web (Web-A) inspects/researches exact repository
→ Web-A seals contract + bounded implementation authority
→ Harness validates/applies exact operations
→ deterministic verification in provider-independent sandbox
→ independent Web code review (Web-B)
   ├─ APPROVE
   ├─ REVISE + bounded repair operations → Harness apply/re-verify → Web-B again
   └─ consequential/policy boundary → NEEDS YOU
→ exact publication / Draft PR / Result Bundle
→ original Web-A final intent review
   ├─ APPROVE
   ├─ REVISE + bounded repair operations → Harness apply/re-verify
   │                                  → same PR/new Result Bundle → Web-A again
   └─ ESCALATE → NEEDS YOU
→ READY FOR YOU
→ human review/merge
```

PAIR does **not** select, initialize or charge a Sol/Terra reviewer. PAIR readiness must not require Codex CLI/runtime/auth. Deterministic verification uses the provider-independent sandbox and fails closed when its isolation guarantees are unavailable.

Web-B code review is separate from Web-A final intent review. Web-B checks code-level correctness, security, regressions, tests, scope and performance. Web-A checks the exact published result against original user intent, architecture and acceptance evidence.

Both Web-B and Web-A may return bounded repair operations. The Harness is the only mutation authority. Legacy Codex Phase 8 is not a permitted fallback for a Harness-first PAIR run.

## AUTOPILOT — Harness-first with one adaptive model review pass

Normal users start AUTOPILOT from the same shell:

```text
/auto <goal>
```

No Task Bundle, ZIP, run ID, state directory or internal Node entry point is exposed to the normal user.

```text
user /auto goal
→ original Web-A inspects/researches exact repository
→ Web-A seals contract + bounded implementation authority
→ Harness validates/applies exact operations
→ deterministic verification
→ exactly ONE selected Sol/Terra reviewer (default Sol/high)
   ├─ APPROVE
   ├─ REVISE + bounded repair operations in the same review pass
   │    → Harness validates/applies → deterministic re-verification
   └─ consequential/policy/replan boundary → NEEDS YOU
→ exact publication / Draft PR / Result Bundle
→ original Web-A mandatory final intent review
   ├─ APPROVE
   ├─ REVISE + bounded Web-A repair operations
   │    → Harness apply/re-verify → same PR/new Result Bundle → Web-A again
   │    → NO second Sol/Terra call
   └─ ESCALATE → NEEDS YOU
→ READY FOR YOU
→ human review/merge
```

AUTOPILOT is not a Codex-implementer pipeline. Web-A supplies the initial bounded implementation pack; the selected model is reviewer/repair proposer only. It never receives direct worktree-write or shell mutation authority.

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
→ independent Web-B code review
→ original Web-A final intent review
```

AUTOPILOT:

```text
deterministic verification
→ one selected Sol/Terra adaptive code-review pass
→ original Web-A final intent review
```

WCO does not stack Terra → Sol → Web. AUTOPILOT uses one selected model pass on the normal path. PAIR uses zero model-review turns. A later Web-A repair is not a new model-review round.

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

AUTOPILOT's selected reviewer should include a bounded repair proposal in the same review call when the blocking correction is sufficiently local. This avoids review → repair → model re-review chatter without weakening deterministic verification.

PAIR Web-B `REVISE` uses the same bounded repair transport. A sealed verdict is digest-bound to the reviewed Result generation; stale or conflicting repair authority fails closed.

## Final-review revision boundary

Web-A final review is mandatory in both modes and is bound to the exact Result Bundle plus freshly attested Draft PR head.

A final `REVISION_REQUESTED` is always **Web-A-proposed + Harness-applied** in the normal Harness-first product flow, regardless of mode:

- the sealed verdict may carry bounded exact repair operations;
- Harness applies and deterministically re-verifies the new digest;
- publication is a strict fast-forward on the same Draft PR;
- the prior publish/Result/review generation remains immutable evidence;
- a new revision Result Bundle is created and sent back to Web-A;
- AUTOPILOT does not call the frozen Sol/Terra reviewer again.

The legacy model-owned Phase 8 path exists only for compatibility with pre-Harness prepared runs.

## Mode-aware doctor/readiness

`wco doctor` defaults to PAIR readiness. `wco doctor --mode AUTOPILOT` adds Codex reviewer runtime/auth probes.

PAIR readiness requires provider-independent verification isolation, Git/GitHub publication prerequisites and Web connectivity; it must not fail merely because Codex runtime/auth is absent.

AUTOPILOT requires the common prerequisites plus the selected model review runtime/auth.

## Durable state and recovery

Harness mutation/authority transitions are serialized and persisted before side effects. Independent reads, evidence collection and safe attestations may run concurrently where they cannot race authority changes.

Recovery principles:

- exact artifact and run identity are create-once/frozen;
- ambiguous model calls are not replayed automatically;
- bounded repair checkpoints are durable before mutation;
- apply is resumable/idempotent against exact preimage/postimage classification;
- deterministic verification binds the exact effective digest;
- final Web revision uses a write-ahead revision checkpoint before publication;
- publication and Draft PR receipts bind exact Git heads;
- crash recovery adopts exact durable pushed state rather than reconstructing authority from a changed worktree;
- stale Web approval is rejected after Result Bundle/head movement;
- READY is freshly re-attested rather than trusted from a cached UI state.

## Performance policy

WCO optimizes latency/token cost by reducing model round trips rather than weakening verification:

- PAIR: zero Codex model turns by design;
- AUTOPILOT: one selected model review pass by default;
- adaptive model `REVISE` returns bounded repair operations in the same pass when possible;
- Web-A final repairs do not trigger another model review;
- deterministic context selection sends changed files + dependency hints rather than whole-repo context by default;
- independent reads/research may run concurrently, while mutation/authority transitions remain serialized;
- Harness verification/publication reuse exact durable receipts instead of repeating model work.

## Human-owned actions

Neither mode automatically merges, marks a PR ready, enables auto-merge, force-pushes, pushes protected branches directly, deploys, releases, publishes packages or deletes remote branches.

`READY_FOR_YOU` means the exact Draft PR head passed WCO's required gates and is ready for human review/merge. It is not merge authority.

## Hosted-service boundary

Local product flow, profile-neutral relay protocol, personal reference adapter, managed client, GPT instructions and fail-closed metadata are repository-owned and testable. Provider-authorized personal relay/GPT configuration or a managed relay/OAuth deployment, plus real hosted-Web acceptance, remain external runtime gates; synthetic CI is not proof of those external systems.
