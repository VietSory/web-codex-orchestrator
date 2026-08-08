# Web Codex Orchestrator

WCO turns Web-authored software work into **registered, constrained and independently verified local changes**. The Web side owns architecture/specification/implementation authority; the local side applies only registered bytes, verifies them, publishes evidence and keeps Git/GitHub mutations inside explicit phase boundaries.

> Current stacked development status: Phase 9–13 are frozen on the stacked Draft-PR chain; Phase 14 durable Web verdict orchestration is the active Draft dependency. `main` remains at merged Phase 8 until the user chooses to merge the stacked PRs.

## Core trust model

```text
ChatGPT Web / Web Authority
  research + repo map + locked spec + exact code operations
                  ↓
      registered implementation pack
                  ↓
WCO local control plane
  validate identity/preimages/policy
  apply exact registered bytes
  deterministic verification
  Terra read-only review
  Sol read-only review
                  ↓
        READY_FOR_PUBLISH
                  ↓
Git/GitHub delivery phases
                  ↓
          human decides merge
```

Important boundaries:

- loose chat text or a loose patch never becomes implementation authority;
- downloaded archives are untrusted until validated/registered;
- Phase 10 has no local implementer-model turn: it applies exact Web-authored bytes;
- reviewers are read-only/no-network and must bind one exact change-set digest;
- WCO never treats model output itself as authorization;
- merge remains a human decision.

See `SECURITY.md`, `ARTIFACT-REGISTRY.md`, `WEB-AUTHORITY-CONTRACT.md` and the phase documents for normative details.

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

Useful release gates:

```bash
npm run phase8:release-gate
npm run phase9:release-gate
npm run phase10:release-gate
npm run phase11:release-gate
npm run phase12:release-gate
npm run phase13:release-gate
npm run phase14:release-gate
```

The unit runner executes test files in bounded independent processes so one leaked handle cannot hide the failing suite behind a long global hang.

## Current operator flow

The durable control plane introduced in Phase 11 now drives the Phase 9–14 path. Explicit lower-level commands remain supported as audit/debug surfaces.

### 1. Intake and prepare a task

```bash
node dist/cli/index.js intake ./downloads/wco-task.zip \
  --state-dir ~/.local/state/web-codex-orchestrator

node dist/cli/index.js prepare ./downloads/wco-task.zip \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json
```

Preparation creates the canonical isolated worktree and run receipt. It does not invoke Codex or execute downloaded payloads.

### 2. Durable Phase 9–14 control

```bash
wco-control continue \
  --run-id <task-id>:<task-bundle-sha256> \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json \
  [--web-pack ./downloads/wco-web-implementation-pack.zip] \
  [--verdict ./downloads/web-verdict.json] \
  [--max-transitions 8] \
  [--json]
```

`--web-pack` and `--verdict` are one-shot external inputs. The controller consumes each only for its matching sealed transition and stops at a true missing-input, retry-backoff, revision, or human boundary. A verdict is never replayed into a later review round.

Read-only surfaces:

```bash
wco-control status --run-id <run-id> --state-dir <state-dir> --json
wco-control next --run-id <run-id> --state-dir <state-dir> --json
```

### 3. Lower-level authority/executor surfaces

```bash
wco-web-authority register \
  --run-id <task-id>:<task-bundle-sha256> \
  --archive ./downloads/wco-web-implementation-pack.zip \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json \
  --json

wco-executor execute \
  --run-id <task-id>:<task-bundle-sha256> \
  --artifact-sha256 <registered-pack-sha256> \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json \
  --json
```

Production execution checks cheap artifact identity first, then Codex auth/sandbox availability, then fresh canonical authority, and only then starts product-worktree mutation. Missing artifact/config problems therefore fail quickly; auth/sandbox failures still happen before a partial product edit.

### Existing delivery/review commands

Phases already merged also expose:

```text
wco execute / execution-status
wco publish
wco create-draft-pr
wco package-result
wco submit-web-verdict / web-review-status
wco revise / revision-status
```

These remain supported lower-level operations while the durable control plane composes them behind exact transition receipts.

## Performance and token discipline

`PERFORMANCE.md` is part of the architecture, not a post-release wish list. Current rules include:

- content-addressed repository/project context keyed by Git tree/blob SHA;
- progressive disclosure instead of resending the whole repo/transcript;
- stable prompt prefixes where possible;
- bounded concurrency and backpressure rather than unbounded `Promise.all` fan-out;
- bounded logs/state/evidence and subprocess output;
- selective verifier/reviewer context;
- token/cache/turn/retry telemetry when exposed by the runtime;
- no redundant local implementation turn in Phase 10;
- status reads do not start model/runtime work;
- Git FSMonitor/untracked-cache support may be detected/recommended, but WCO does not silently rewrite user Git configuration.

Phase 14 additionally keeps Web verdict lifecycle authority in at most four bounded run-scoped staged files plus bounded receipts. It never scans global Codex session history or browser transcripts to recover an orchestration decision.

`UPSTREAM-COMPATIBILITY.md` converts relevant `codex-chatgpt-web` bridge/session/browser incidents into negative requirements. Problems inside OpenAI Codex internals are compatibility-only: WCO may detect, checkpoint, retry safely or surface diagnostics, but does not fork/patch OpenAI internals.

## Security summary

- state/worktree/registry trust paths are confined and symlink-aware;
- sensitive reads are bounded and re-attest file identity/size;
- registry/workflow artifacts are hash-bound;
- Git/GitHub publication paths reject force-push/merge authority unless explicitly allowed by the phase contract;
- Phase 8 uses clean bare Git transports to avoid worktree-local URL rewrite rules redirecting credentials/publication;
- Phase 10 changed-path, file-byte and permission-mode state are included in exact approval identity;
- crash recovery accepts only registered preimage/postimage states and rejects unrelated changes;
- review/verification approvals are invalidated by digest drift;
- Web verdict retries are bound to one exact canonical verdict digest/review round and a fresh exact PR head.

See `SECURITY.md` for threat assumptions and exact boundaries.

## Documentation map

```text
PHASE3.md .. PHASE14.md       normative phase contracts
PHASE*-COVERAGE.md            executable evidence maps where present
ARTIFACT-REGISTRY.md          registered artifact authority
WEB-AUTHORITY-CONTRACT.md     Web-side protocol/locks
PERFORMANCE.md                CPU/RAM/I/O/token/context architecture
UPSTREAM-COMPATIBILITY.md     bridge/Codex compatibility posture
SECURITY.md                   trust boundaries/threat assumptions
```

## Optional real-runtime checks

Real local checks are intentionally opt-in because they consume/require local Codex/runtime state:

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:sandbox-integration
WCO_RUN_CODEX_INTEGRATION=1 npm run test:codex-integration
```

The final v1.0 hardening phase will publish `LOCAL-FINAL-CHECKLIST.md` with the exact Windows/WSL/native bridge/Codex smoke commands that cannot be proven by GitHub CI.
