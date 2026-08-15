# Architecture

WCO is a durable local control plane between provider-generated semantic/implementation proposals and a human-owned Git merge decision. Correctness is based on exact identities, closed authority schemas, deterministic verification and durable receipts—not on conversational continuity, provider UI state or a hosted WCO service.

## Normal system boundary

```text
user goal
   ↓
local ChatGPT/Codex semantic author
   │  read-only structured output
   ↓
WCO bounded exact repository reads
   │  summary / tree / search / file or byte-region reads
   ↓
sealed WCO contract
   ↓
canonical prepared run
   ↓
Harness-side Codex implementation planner
   │  read-only bounded proposal, exact job/run binding
   ↓
WCO/Harness validation + isolated mutation
   ↓
deterministic verification / repair
   ↓
mode-specific code review
   │  PAIR: independent semantic review
   │  AUTOPILOT: frozen configured Sol/Terra reviewer policy
   ↓
exact Git/GitHub publication evidence + Draft PR
   ↓
independent/final semantic intent review bound to exact result evidence
   ↓
READY_FOR_YOU
   ↓
human merge / release
```

Normal WCO state, repository/worktree state, exact-read receipts, semantic mailbox, Task/Result Bundles, mutation authority, verifier state and Git recovery state remain on the user's machine.

Provider account communication is outbound through the bundled official Codex runtime. WCO does not require a normal-path WCO server, database, relay, public endpoint, tunnel, MCP App or browser automation layer.

## Zero-config normal transport

A fresh trusted config intentionally has no `web_bridge` field. Absence selects the local ChatGPT/Codex bridge. The internal transport identity is `chatgpt_codex`; normal users do not type or store that profile name, an endpoint or a transport secret.

First provider use delegates authorization to the bundled official Codex login flow. Codex owns the ChatGPT OAuth/browser handoff and credential lifecycle. WCO checks readiness but does not parse/copy provider tokens or browser state.

After authorization:

```text
per-task browser interaction = 0
per-task transport setup     = 0
per-task credential input    = 0
```

If authorization expires, `wco web connect` repeats only the official ChatGPT authorization flow. A local runtime/auth failure cannot silently activate a compatibility transport.

## Semantic authoring

The semantic author is deliberately not a filesystem/Git agent. It sees intent/repository identity and can emit only phase-appropriate structured authority:

```text
repository_command
  - summary
  - bounded tree
  - bounded search
  - exact full-file/byte-region read

or

contract_sealed
```

WCO executes repository commands itself against the exact bound repository/base and returns the result to the semantic thread. Sensitive-path, traversal/symlink and read-bound checks remain local.

The current semantic SDK adapter is read-only, approval=`never`, network disabled and provider Web search disabled. External live-Web research is not a release capability of the local transport today. If added later, it must be a separately reviewed semantic-only adapter and must not widen mutation, shell, Git, credential or shipment authority.

## Canonical preparation and implementation proposal

After contract sealing, WCO materializes/accepts canonical task authority and prepares the isolated run. The generated `run_id` is bound back to the bridge before local workflow state may become `PREPARED`.

Only then does a separate Harness-side Codex implementation planner run. It is also read-only/no-network and returns a closed `WebImplementationSubmission` containing bounded create/replace/delete postimages.

The planner itself does **not** write the repository. WCO revalidates:

- protocol/job/run identity;
- task/contract binding;
- path policy and forbidden paths;
- content/postimage SHA-256;
- exact preimage/read requirements;
- operation and payload bounds.

Only validated authority reaches Harness/executor mutation machinery.

A durable provider-turn reservation is written before an authority-bearing implementation call. If a crash leaves a reservation without a sealed result, WCO fails closed instead of blindly generating a second conflicting proposal.

## Harness and verifier authority

Harness/executor remains the only component that may mutate the isolated worktree, execute repository validation commands, calculate authoritative change-set digests, create repair checkpoints or perform Git publication steps.

Model/provider output never directly:

- writes files;
- executes Git mutation;
- pushes;
- opens/updates a PR as authority;
- marks ready or merges;
- deploys, tags or releases.

Deterministic verification remains mandatory before reviewed/published state can advance. Missing sandbox/isolation never falls back to unrestricted host execution.

## Mode-specific review

### PAIR

PAIR keeps the user-oriented collaboration flow but still uses the same canonical contract, implementation proposal, Harness mutation and deterministic verification boundaries.

After verified code exists, policy may require an independent semantic code-review job. That review is bound to exact change/result evidence and can only return a closed verdict/repair authority. Harness applies and re-verifies any accepted repair.

A final semantic intent review remains required before `READY_FOR_YOU`.

### AUTOPILOT

AUTOPILOT continues through bounded orchestration/recovery policy without routine user intervention. Its configured Sol/Terra reviewer selection is frozen for the active run, review/repair budgets remain bounded, and any repair returns through Harness plus deterministic re-verification.

The final semantic intent review remains mandatory. AUTOPILOT does not acquire merge/release authority.

## Review identity and evidence

Review authority is not inferred from a browser tab or ambient conversation. WCO creates review jobs with exact durable bindings. Provider thread IDs are continuity metadata only.

Final/review verdicts are parsed through closed WCO schemas and checked against exact run/result evidence before lifecycle state changes.

If provider continuity is lost, WCO relies on durable intent/contract/result evidence and allowed thread recovery semantics rather than granting stronger authority to a replacement conversation.

## Context architecture

Repository context is progressive and exact:

```text
goal
→ repository identity / summary / bounded tree or search
→ focused exact file/region reads
→ content-addressed reuse for unchanged bytes
→ sealed contract
→ implementation/result deltas
```

Disposable local summaries, symbol/reference indexes or ranking caches may improve localization. They are advisory only. Whenever context becomes mutation authority it must resolve back to canonical Git/file content and exact digests/read receipts.

## Durable state and replay

WCO-owned durable state is the recovery authority, subject to re-attestation of stronger evidence.

Examples include:

- author/review job identities;
- repository-command receipts;
- sealed contracts;
- canonical task/run identities;
- provider-turn reservations and sealed outputs;
- executor/verifier checkpoints;
- selected artifacts/change-set digests;
- Git/GitHub publication evidence;
- Result Bundle and final verdict bindings.

Already sealed authority can be reused idempotently. Ambiguous authority-bearing provider/network outcomes are not blindly replayed.

## Authority hierarchy

From stronger to weaker authority:

1. trusted WCO configuration and registered repository policy;
2. canonical accepted task/run identity and sealed semantic contract;
3. exact Git repository/base/tree state and read receipts;
4. validated implementation/repair authority with exact preimage/postimage identity;
5. Harness transaction state and deterministic verification bound to exact change-set digests;
6. mode-specific code-review evidence bound to those digests;
7. exact Git/GitHub publication, Draft PR and Result Bundle evidence;
8. final semantic verdict bound to exact durable intent/result evidence;
9. durable orchestration receipts that advance only after re-attesting stronger evidence;
10. provider thread/status/log/UI state and disposable caches.

A provider `success` flag cannot overrule changed Git, archive, PR, Result Bundle, review or digest identity.

## Advanced compatibility transports

Explicit compatibility/operator profiles may remain:

```text
web_native_mcp
managed_actions
personal_actions
actions_relay
manual_file
```

They are never the fresh default and never an automatic fallback from the zero-config local transport. Their existence does not widen normal-user setup requirements or Harness authority.

## Parallelism and serialization

Independent exact reads, context ranking and safe attestations may run concurrently. Authority-bearing transitions—contract adoption, prepared-run binding, implementation adoption, mutation, artifact selection, repair adoption, commit/push and publication promotion—remain serialized/idempotency-bound where required.

## Human shipment boundary

Neither PAIR nor AUTOPILOT automatically merges, marks a PR ready, enables auto-merge, force-pushes, deploys, tags, publishes npm or creates a release.

`READY_FOR_YOU` means the exact reviewed Draft PR is ready for the human. It is not shipment authority.

## Product entry point

```text
npm install -g web-codex-orchestrator
cd repository
wco
→ first provider use: one official ChatGPT authorization when required
→ goal
→ local semantic author + Harness implementation/verification/review
→ reviewed Draft PR
→ READY_FOR_YOU
→ human merge/release
```

See [frozen user experience contract](user-experience-contract.md), [web bridge](web-bridge.md), [ADR 0004](adr/0004-chatgpt-codex-local-default.md), [job modes](job-modes.md), [operations](operations.md) and [protocols](protocols.md).