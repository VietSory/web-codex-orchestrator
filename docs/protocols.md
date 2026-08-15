# Protocols and Authority

This document describes the product-level protocol boundaries. JSON schemas, canonical validators, and executable tests remain normative when prose and implementation disagree.

## Run identity

A run is identified by the task identity plus the accepted Task Bundle archive SHA-256. The exact accepted bundle, repository registration, base commit, delivery branch and state root are rebound throughout later transitions.

## Task Bundle

Task Bundles are untrusted input. Intake validates archive structure, path safety, supported entries, checksum coverage, schema versions and size/count limits before accepted bytes become run authority.

The template under `templates/task-bundle/` is the current reference shape. A successful directory validation proves contract validity; secure intake/preparation still determines whether the bundle is executable.

## Web implementation authority

External implementation work becomes authority only after a Web implementation pack is registered against the exact repository snapshot and accepted specification.

The pack binds, among other fields:

- repository inventory and Git object identities;
- read coverage/project-map evidence;
- architecture/acceptance/prohibited-change locks;
- exact create/replace/delete operations;
- exact preimages for existing files;
- payload hashes and closed-world checksums.

Registration is content-addressed. Loose prompts, patches, clipboard text or a different archive cannot override a registered artifact.

Public schemas live in `schemas/`.

## Harness execution

The executor independently revalidates the registered artifact and all operation preimages before the first product write. The Harness then applies exact registered bytes, verifies postimages and computes an exact change-set digest. Deterministic verification must pass for that exact digest before review/publication authority can advance.

The review strategy is explicit and durable:

- `web` — PAIR: no Terra/Sol approval is required or synthesized. Independent Web-B code review is a separate durable authority gate.
- `model` — AUTOPILOT: exactly one frozen Sol or Terra reviewer is used on the normal model-review pass.
- missing strategy — legacy compatibility only; older receipts may retain their historical dual-review contract.

Reviewers never receive direct filesystem or shell-mutation authority. A `REVISE` may carry only bounded create/replace/delete repair operations. The Harness binds them to the exact reviewed source digest, validates current preimages/path policy/postimages, applies them and reruns deterministic verification on the repaired exact digest.

## Code-review authority

PAIR Web-B and AUTOPILOT Sol/Terra review are code-level gates with different transports but the same mutation boundary. Their evidence must bind the exact reviewed Result/change-set generation. Stale approval or repair evidence cannot authorize a newer digest.

AUTOPILOT defaults to one adaptive selected-model pass. When a blocking correction is local enough to express as bounded operations, the same review response can carry the repair proposal so WCO avoids a second model round trip. Deterministic verification, not conversational agreement, establishes the repaired executable result.

## Git and Draft PR publication

Publication commits only the exact verified change set to the configured delivery branch. Initial branch creation uses an expected-absent compare-and-swap guard so a racing remote branch cannot be silently overwritten. Repairs/revisions are strict fast-forward updates of the same branch; force push is not authority.

A pull request is accepted only when it is open, unmerged, Draft, in the expected repository, and has the exact base/head identity. WCO does not expose merge, Mark Ready, auto-merge or branch-deletion authority.

Publication generations are durable evidence. A repaired head supersedes the prior generation for lifecycle progress but does not erase its immutable publish/Result/review evidence.

## Result Bundle

A Result Bundle is a deterministic handoff archive containing bounded public evidence for the exact published run/head. The archive is independently verified before its durable receipt can advance the workflow.

Initial Result Bundles and revision Result Bundles preserve the exact generation chain. A final-review repair produces a new revision Result Bundle bound to the previous reviewed head, the new fast-forward head and the same Draft PR identity.

The embedded review contract and verdict schema under `src/result-bundle/resources/` are runtime resources and are shipped with the compiled package.

## Web verdict and repair/revision

A verdict source is untrusted until bounded stable read, canonicalization, schema/policy validation, Result Bundle identity checks and fresh Draft PR attestation all agree.

There are two Web review roles in the normal product:

- Web-B: independent PAIR code review.
- Web-A: the original authoring Web identity, reused as the mandatory final intent reviewer.

`APPROVE` never grants merge authority. `REVISE` may seal bounded repair operations only for the exact generation reviewed. `ESCALATE`/policy ambiguity stops at the user boundary.

A final Web-A revision is always Web-proposed + Harness-applied on the normal Harness-first path in both modes. WCO writes the revision authority checkpoint before publication, fast-forwards the same Draft PR, creates a new immutable revision Result Bundle and sends it back to Web-A. AUTOPILOT does not invoke its frozen Sol/Terra reviewer a second time for that final repair.

Legacy model-owned Phase 8 remains compatibility behavior only for pre-Harness prepared runs.

## Durable orchestration and recovery

The controller checkpoints an exact request before external/model/mutating work. Attempts are fenced by identity, retries use durable budgets/backoff, and crash recovery adopts prior side effects only after re-attestation.

Important recovery rules include:

- an ambiguous model call is not blindly replayed;
- repair authority is persisted before mutation;
- final Web revision persists previous-head→dirty-repair identity before Git publication;
- a crash after commit/push can adopt exact durable Phase10 publication authority rather than reconstructing trust from a changed worktree;
- stale publish/Draft/Result/Web approvals do not satisfy a repaired digest;
- READY is freshly re-attested against the exact live Draft PR head.

Session/transcript/browser state is never searched to synthesize missing protocol input.

## Web bridge v1

`wco-web-bridge-v1` is a transport envelope for authoring jobs, repository commands, implementation submissions and review verdicts. It is deliberately separate from Task Bundle and Web Implementation Pack authority. Relay IDs, events or acknowledgements never substitute for canonical artifact/digest bindings. Mutations require idempotency keys and conflicting replays fail closed.
