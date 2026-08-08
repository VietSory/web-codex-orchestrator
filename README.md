# Web Codex Orchestrator

WCO turns Web-authored software work into **registered, constrained, independently verified and durably recoverable local changes**. Web artifacts own architecture/specification/implementation/verdict authority; WCO applies only registered bytes, verifies exact changed state, publishes evidence and keeps Git/GitHub mutations inside explicit phase boundaries.

> Stacked development status: Phases 9–15 are frozen on stacked Draft branches with exact-head CI. Phase 16 v2 is the final GitHub-side hardening branch/PR. `main` is intentionally not merged by WCO automation; merge/Ready remain human decisions after local validation.

## Trust model

```text
ChatGPT Web authority
  research + locked spec + exact implementation/verdict artifact
                     ↓
          registered implementation pack
                     ↓
WCO durable local control plane
  identity/preimage/path/policy validation
  exact registered mutation
  deterministic verification
  Terra read-only review
  Sol read-only review
                     ↓
             READY_FOR_PUBLISH
                     ↓
        normal non-force Git publish
                     ↓
                Draft PR only
                     ↓
                Result Bundle
                     ↓
         explicit sealed Web verdict
            ↙          ↓          ↘
        APPROVE      REVISE     ESCALATE
                       ↓
              same Draft PR branch
                       ↓
               new Result Bundle
```

Important boundaries:

- loose chat/browser history/model text never becomes implementation or verdict authority;
- downloaded archives are untrusted until validated and registered;
- reviewers are read-only/no-network and bind one exact change-set identity;
- WCO never treats model/session/transport success itself as authorization;
- publication is exact normal fast-forward/non-force Git only;
- orchestration never marks a PR Ready, merges, force-pushes, rebases published history or deletes phase branches;
- OpenAI Codex app/CLI/agent and browser-bridge internals are compatibility boundaries, not WCO patch targets.

See `SECURITY.md`, `ARTIFACT-REGISTRY.md`, `WEB-AUTHORITY-CONTRACT.md`, `UPSTREAM-COMPATIBILITY.md`, `PERFORMANCE.md` and the phase documents.

## Requirements

- Node.js 20+
- Git
- npm
- for real Codex verification/review: the WCO-pinned Codex runtime and authenticated native environment

Normal GitHub CI uses fake model/sandbox adapters and consumes no native Codex session/account usage.

## Build and deterministic verification

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Final GitHub-side release gate:

```bash
npm run phase16:release-gate
```

Focused phase gates remain available. The aggregate unit runner executes test files in bounded independent processes so a leaked handle cannot silently turn one failing suite into an endless global hang.

## Durable operator flow

Build first:

```bash
npm run build
```

Inspect without advancing work:

```bash
node dist/orchestration/standalone-cli.js status \
  --run-id <task-id>:<task-bundle-sha256> \
  --state-dir <state-dir> \
  --json

node dist/orchestration/standalone-cli.js next \
  --run-id <task-id>:<task-bundle-sha256> \
  --state-dir <state-dir> \
  --json
```

Advance only with explicit external inputs when required:

```bash
node dist/orchestration/standalone-cli.js continue \
  --run-id <task-id>:<task-bundle-sha256> \
  --state-dir <state-dir> \
  --config <config.json> \
  --web-pack <registered-pack.zip> \
  --json

node dist/orchestration/standalone-cli.js continue \
  --run-id <task-id>:<task-bundle-sha256> \
  --state-dir <state-dir> \
  --config <config.json> \
  --web-verdict <web-verdict.json> \
  --json
```

`continue` is capped to 1..32 transitions per invocation. It stops on human/input boundaries and does not scrape/fabricate a later Web verdict. After a revision returns to `WAIT_WEB_VERDICT`, a **new** explicit verdict artifact is required.

Pause/resume/diagnostics:

```bash
node dist/orchestration/standalone-cli.js pause --run-id <run-id> --state-dir <state-dir>
node dist/orchestration/standalone-cli.js resume --run-id <run-id> --state-dir <state-dir>
node dist/orchestration/standalone-cli.js doctor --run-id <run-id> --state-dir <state-dir> --config <config.json> --json
```

The lower-level `wco`, `wco-web-authority` and `wco-executor` CLIs remain supported debugging/operational surfaces. The durable controller reuses hardened lower-layer services rather than duplicating publisher/reviewer/verifier/Result Bundle logic.

## Recovery and external side effects

Every mutating transition is SHA-256 sealed and durably checkpointed before external work. Crash recovery never assumes that a lost UI/tool result means an operation did or did not commit. It reconciles exact canonical evidence and adopts only terminal evidence bound to the same run/request/head/digest.

Examples include:

- Phase 9 immutable pack registration;
- Phase 10 exact executor receipts/evidence;
- exact pushed Git commit/remote head;
- exact open Draft PR/head;
- exact Result Bundle;
- exact Web verdict/fresh Draft-PR head;
- exact same-PR revision `RESULT_READY` receipt.

Late/stale results are fenced by attempt identity and cannot advance a newer attempt.

## Performance, token and session discipline

`PERFORMANCE.md` is normative for v1 claims. Implemented rules include:

- per-run execution fencing and bounded transition count;
- bounded retry/backoff/circuit behavior with durable retry-not-before timestamps;
- GitHub rate-limit server hints honored within the outer elapsed budget;
- bounded logs/state/evidence/process output and a 1 MiB GitHub REST response cap;
- status/next paths do not start model/browser work;
- no global Codex session-history/sidebar/picker scan to discover WCO lifecycle;
- exact terminal receipt adoption prevents blind replay after crashes;
- completed Phase 8 revision model/input/output usage is recorded exactly once in the outer ledger;
- Phase 10 lower-layer model usage remains governed by its frozen reviewer/verifier policies because its receipt does not expose token counters.

WCO v1 reuses existing immutable/hash-bound artifacts and sealed request identities. It does **not** claim a separate repository-wide project-map cache subsystem where no executable implementation exists.

## Upstream compatibility

`UPSTREAM-COMPATIBILITY.md` converts relevant external failure modes into WCO negative requirements. Current public evidence includes Codex reports about large-session picker/list behavior, huge rollout resume memory growth, session-index divergence, model/reasoning resume behavior, rollout persistence errors and lost post-tool continuation.

The current `codex-chatgpt-web` README describes fresh Temporary Chat turns, serialized browser turns, explicit diagnostics and Codex-local task history; it also currently documents managed background installation as macOS-only. WCO therefore treats browser/bridge availability on Windows/WSL as a **local compatibility proof**, not a CI guarantee.

## Security summary

- trust/state/worktree/registry paths are confined and symlink-aware;
- sensitive/canonical reads are bounded and re-attest identity/size;
- critical WCO-owned receipts/evidence use durable/synced persistence where implemented;
- Git/GitHub mutation paths reject force-push/merge authority;
- clean Git transport/auth boundaries avoid worktree-local URL rewrite redirection;
- changed path/bytes/mode participate in approval identity;
- crash recovery accepts only exact canonical terminal evidence and rejects drift;
- Web verdicts and revisions remain fresh Draft-PR/head/review-round bound;
- review/verification approvals are invalidated by digest drift.

See `SECURITY.md` for threat assumptions and exact platform boundaries.

## Documentation map

```text
PHASE3.md .. PHASE16.md       normative phase contracts
ARTIFACT-REGISTRY.md          registered artifact authority
WEB-AUTHORITY-CONTRACT.md     Web-side protocol/locks
PERFORMANCE.md                CPU/RAM/I/O/token/session architecture
UPSTREAM-COMPATIBILITY.md     bridge/Codex compatibility posture
SECURITY.md                   trust boundaries/threat assumptions
LOCAL-FINAL-CHECKLIST.md      native/local proof still required after GitHub audits
```

## Final completion rule

Phase 16 is complete only when one exact head passes GitHub CI and then two independent maintainer audits—architecture/security/correctness and runtime/performance/operations—both pass that same exact head. Any blocker creates a new head and invalidates both audits.

After that point, GitHub-side work is done. Run only `LOCAL-FINAL-CHECKLIST.md` in the real Windows/WSL/native Codex/bridge environment and return its requested **sanitized** diagnostics; never paste tokens, cookies, authorization headers or browser profiles.
