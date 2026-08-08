# Architecture

WCO is a durable orchestration layer between untrusted external implementation evidence and a human-owned Git merge decision. Correctness is based on exact identities and durable receipts, not on conversational continuity.

## System boundary

```text
untrusted Task/Web input
        ↓
validation + content identity
        ↓
WCO-owned isolated state/worktree
        ↓
deterministic mutation + verification
        ↓
independent read-only model review
        ↓
exact Git/GitHub publication evidence
        ↓
explicit external verdict
        ↓
human merge authority
```

The browser, ChatGPT/Codex transcripts, model thread history, terminal output, and derived caches are transport or diagnostic surfaces. They never become lifecycle authority.

## Authority model

From highest to lower authority:

1. trusted WCO configuration and registered repository policy;
2. canonical accepted Task Bundle and run identity;
3. exact Git repository/base/tree state;
4. immutable registered Web artifacts and operation preimages;
5. deterministic verification and independent reviewer evidence bound to one change-set digest;
6. durable orchestration receipts that may advance only after re-attesting the stronger evidence above;
7. logs, UI/session state, caches, and human-readable output.

Recovery follows the same hierarchy. A persisted `success` flag cannot overrule changed Git, archive, PR, or receipt identity.

## Design principles

### Fail-safe defaults and complete mediation

Ambiguity is a stop condition. Security-sensitive accesses are revalidated at the point where their result becomes authority, including recovery and publication. This follows the classic protection principles described by Saltzer and Schroeder: fail-safe defaults, complete mediation, least privilege, separation of privilege, and psychological acceptability.

Applied in WCO:

- unsupported/malformed authority fails closed instead of guessing;
- Git/GitHub identities are checked again before an irreversible boundary;
- model, verifier, Git, and GitHub capabilities are separated;
- dangerous actions stay outside the autonomous command set.

Reference: https://web.mit.edu/saltzer/www/publications/protection/index.html

### End-to-end correctness

Lower layers validate their own work, but the orchestration endpoint still verifies the property that matters to the workflow. This mirrors the end-to-end argument from Saltzer, Reed, and Clark: lower-layer mechanisms can help, but correctness that only the endpoint can establish belongs at the endpoint.

Applied in WCO:

- a successful push is adopted only after the expected remote SHA is observed;
- a Draft PR is authority only after repository/base/head/draft state are re-attested;
- a Result Bundle and Web verdict are bound to the exact published head;
- crash recovery re-attests completed side effects rather than replaying them blindly.

Reference: https://web.mit.edu/saltzer/www/publications/endtoend/endtoendA4.pdf

### Bounded resources

Every potentially adversarial or long-lived surface needs an explicit bound: archive entries/bytes, JSON receipts, process output, subprocess time, retries, event records, candidate scanning, model turns/tokens, and concurrency. Bounds are part of correctness, not only performance tuning.

### Content-addressed evidence

Stable artifacts are named and compared by hashes or immutable Git identities wherever practical. Derived project maps and caches can accelerate work, but deleting a cache must not change an authorization decision.

### Recovery instead of replay

WCO stores the smallest durable evidence required to resume a transition. Recovery prefers exact receipt adoption over repeating a model turn, commit, push, PR creation, or bundle build. This reduces duplicate side effects, latency, and token cost.

## Secure development and release references

WCO's release engineering should continue to align with established software-supply-chain guidance:

- NIST SSDF SP 800-218: integrate secure-development practices into the lifecycle rather than treating security as a final audit. https://csrc.nist.gov/pubs/sp/800/218/final
- SLSA: attach verifiable provenance to release artifacts so a consumer can trace where, when, and how they were built. https://slsa.dev/spec/v1.2/provenance
- The Update Framework (TUF): consider delegated, rollback-resistant update metadata if WCO later gains an automatic updater. It is unnecessary before an update channel exists. https://theupdateframework.io/spec/
- Command Line Interface Guidelines: keep the CLI human-first, consistent with common conventions, concise by default, and composable through stable machine output. https://clig.dev/

These references guide boundaries and release engineering; they are not compliance claims.
