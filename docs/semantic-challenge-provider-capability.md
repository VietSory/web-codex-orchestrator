# Semantic Challenge Provider Capability Boundary

This branch prepares the provider-facing half of blind semantic challenge integration without changing runtime authority.

## Preconditions

A concrete provider adapter may expose `SemanticChallengeTransport` only after the recovery-qualified challenge path can durably bind each repository observation to goal-bound evidence. Provider wiring must not bypass `SemanticChallengeRepositorySession`, inject Web-A evidence, or reuse normal authoring/final-review authority.

## Required ordering

1. Create a challenge-scoped provider job from only the blind challenge request.
2. Accept one strictly increasing remote action at a time.
3. Route repository commands through the challenge-owned exact reader.
4. Persist the trajectory-bound, byte-stripped evidence snapshot before returning repository result bytes to the provider.
5. Require the provider's sealed understanding to match the independently re-read understanding digest.
6. Keep the whole path shadow-only and fail-open at any future runtime hook.

## Non-authority invariants

The provider capability must not approve, reject, revise, repair, publish, merge, mutate Git, alter verifier results, or modify recovery authority. It must remain an optional capability intersection rather than widening the base `WebBridge` contract.

## Recovery boundary

Current durable evidence is sufficient to prove repository evidence provenance after restart, but provider thread state is not yet exactly reconstructible. Interrupted provider-backed challenges therefore require a fresh challenge identity rather than synthetic resume.

## Integration sequencing

The next provider implementation must stack on the shadow/recovery integration head, not directly on either sibling PR #54 or #55. This avoids reintroducing a provider-visible result before durable evidence persistence.
