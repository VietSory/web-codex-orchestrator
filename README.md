# Web Codex Orchestrator

WCO turns Web-authored software work into **registered, constrained and independently verified local changes**. The Web side owns architecture/specification/implementation/verdict authority; the local side applies only registered bytes, verifies them, publishes evidence and keeps Git/GitHub mutations inside explicit phase boundaries.

> Current stacked development status: Phases 9–16 are implemented on stacked Draft branches/PRs. Phase 16 is the final GitHub-side hardening layer. `main` is intentionally not merged by automation; merge remains a user decision after local validation.

## Core trust model

```text
ChatGPT Web / Web Authority
  research + repo map + locked spec + exact code operations
                  ↓
      registered implementation pack
                  ↓
WCO durable local control plane
  validate identity/preimages/policy
  apply exact registered bytes
  deterministic verification
  Terra read-only review
  Sol read-only review
                  ↓
        READY_FOR_PUBLISH
                  ↓
     exact non-force Git publish
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

- loose chat text, browser history or a loose patch never becomes implementation authority;
- downloaded archives are untrusted until validated/registered;
- reviewers are read-only/no-network and bind one exact change-set digest;
- WCO never treats model output, session state or transport success itself as authorization;
- publication is normal fast-forward/non-force Git only;
- WCO never marks a PR Ready or merges it as part of orchestration;
- OpenAI Codex app/CLI/agent internals are compatibility boundaries, not WCO patch targets.

See `SECURITY.md`, `ARTIFACT-REGISTRY.md`, `WEB-AUTHORITY-CONTRACT.md`, `UPSTREAM-COMPATIBILITY.md`, `PERFORMANCE.md` and the phase documents for normative details.

## Requirements

- Node.js 20+
- Git
- npm
- for real Codex verification/review: the WCO-pinned Codex runtime and an authenticated `CODEX_HOME`

Normal CI uses fake model/sandbox adapters and consumes no Codex usage.

## Install / build

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

Focused earlier gates remain available as `phase8:release-gate` through `phase15:release-gate`. The unit runner executes test files in bounded independent processes so one leaked handle cannot hide a failing suite behind a long global hang.

## Durable operator flow

Build first:

```bash
npm run build
```

The Phase 11–16 control plane is exposed by `wco-control` / `dist/orchestration/standalone-cli.js`.

Inspect without advancing work:

```bash
wco-control status \
  --run-id <task-id>:<task-bundle-sha256> \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --json

wco-control next \
  --run-id <task-id>:<task-bundle-sha256> \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --json
```

Advance a run with explicit external inputs only when required:

```bash
wco-control continue \
  --run-id <task-id>:<task-bundle-sha256> \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json \
  --web-pack ./downloads/wco-web-implementation-pack.zip \
  --json

wco-control continue \
  --run-id <task-id>:<task-bundle-sha256> \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json \
  --web-verdict ./downloads/web-verdict.json \
  --json
```

`continue` is bounded to at most 32 transitions per invocation, stops on human/input boundaries and does not scrape or fabricate a later Web verdict. After a `REVISE` round returns to `WAIT_WEB_VERDICT`, a new explicit verdict artifact is required.

Pause/resume and diagnostics remain explicit:

```bash
wco-control pause --run-id <run-id> --state-dir <state-dir>
wco-control resume --run-id <run-id> --state-dir <state-dir>
wco-control doctor --run-id <run-id> --state-dir <state-dir> --config <config.json> --json
```

The lower-level Phase 4–10 CLIs (`wco`, `wco-web-authority`, `wco-executor`) remain supported debugging/operational surfaces. The durable controller reuses their hardened services rather than duplicating Git, verifier, reviewer or Result Bundle implementations.

## Performance and token discipline

`PERFORMANCE.md` is part of the architecture. Current rules include:

- content-addressed repository/project context keyed by Git tree/blob SHA;
- progressive disclosure instead of resending the whole repo/transcript;
- stable prompt prefixes where possible;
- bounded concurrency/backpressure rather than unbounded fan-out;
- bounded logs/state/evidence and subprocess output;
- selective verifier/reviewer context;
- global model/token/turn/retry accounting in durable orchestration;
- reuse of sealed request/context identity across retryable transport failures;
- no session-history scan to discover lifecycle state;
- status reads do not start model/runtime work;
- Git FSMonitor/untracked-cache support may be detected/recommended, but WCO does not silently rewrite user Git configuration.

`UPSTREAM-COMPATIBILITY.md` converts relevant `codex-chatgpt-web` bridge/session/browser incidents into negative requirements. Problems inside OpenAI Codex internals are compatibility-only: WCO may detect, checkpoint, bound, retry safely or surface diagnostics, but does not fork/patch OpenAI internals.

## Security summary

- state/worktree/registry trust paths are confined and symlink-aware;
- sensitive reads are bounded and re-attest file identity/size;
- registry/workflow artifacts are hash-bound;
- Git/GitHub publication paths reject force-push/merge authority;
- clean bare Git transports avoid worktree-local URL rewrite rules redirecting credentials/publication;
- changed-path, file-byte and permission-mode state participate in approval identity;
- crash recovery accepts only exact durable authority/receipt states and rejects drift;
- Web verdicts are freshly Draft-PR/head/review-round bound before they can authorize revision/human completion;
- review/verification approvals are invalidated by digest drift.

See `SECURITY.md` for threat assumptions and exact boundaries.

## Documentation map

```text
PHASE3.md .. PHASE16.md       normative phase contracts
PHASE*-COVERAGE.md            executable evidence maps where present
ARTIFACT-REGISTRY.md          registered artifact authority
WEB-AUTHORITY-CONTRACT.md     Web-side protocol/locks
PERFORMANCE.md                CPU/RAM/I/O/token/context architecture
UPSTREAM-COMPATIBILITY.md     bridge/Codex compatibility posture
SECURITY.md                   trust boundaries/threat assumptions
LOCAL-FINAL-CHECKLIST.md      native Windows/WSL/Codex/bridge proof still required
```

## Final local-only validation

GitHub CI cannot prove the user's real Windows/WSL/native Codex/codex-chatgpt-web behavior. After exact-head CI and the two maintainer audits pass, run **only** the commands/observations in `LOCAL-FINAL-CHECKLIST.md` and return the requested diagnostics. Do not include secrets, cookies, auth headers or tokens.
