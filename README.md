# Web Codex Orchestrator

WCO turns Web-authored software work into **registered, constrained, independently verified and durably orchestrated changes**. Web authority supplies exact implementation/revision inputs; WCO owns lifecycle state, applies only registered authority, verifies exact changes, publishes evidence to one Draft PR and never treats browser/session/model output as merge authority.

Phase 1 through Phase 16 are implemented in the current stacked development line. The repository is still a private `0.1.0` source project: no release, package publication, Ready-for-review transition or merge is performed automatically.

## What the product does

```text
Task Bundle
  → secure validation/intake/preparation
  → registered Web implementation pack
  → exact constrained application
  → deterministic verification
  → independent Terra review
  → independent Sol review
  → commit + protected branch publication
  → one Draft Pull Request
  → verified Result Bundle
  → explicit Web verdict
       APPROVE / ESCALATE → WAIT_HUMAN
       REVISE → bounded same-PR revision
                → next Result Bundle
                → next explicit Web verdict
```

Hard boundaries:

- loose chat text, loose patches, browser state and transcripts are never implementation authority;
- downloaded archives remain untrusted until validated/registered;
- Phase 10 has no redundant local implementation-model turn: exact registered Web bytes are applied and reviewed;
- reviewers are independent, read-only/no-network and bind the exact change-set digest;
- revision authority comes only from the sealed Web Review receipt/request chain;
- publication never amends/rebases or destructively force-updates an existing branch; Phase 5A's empty expected-value lease is only an atomic create-if-absent race guard, and Phase 8 revisions are ordinary exact-head fast-forwards;
- WCO never marks a PR Ready, enables auto-merge, deletes the delivery branch or merges `main`;
- merge remains a human decision.

See `SECURITY.md`, `WEB-AUTHORITY-CONTRACT.md`, `ARTIFACT-REGISTRY.md`, `PERFORMANCE.md`, `UPSTREAM-COMPATIBILITY.md` and the phase documents.

## Requirements

- Node.js 20+
- Git
- npm
- for real Codex verification/review: the WCO-pinned Codex runtime and authenticated local Codex state

Normal GitHub CI uses fake model/sandbox adapters and consumes no Codex quota.

## Start from a source checkout

Install and build once:

```bash
npm ci
npm run build
```

You do **not** need a global install to use the source checkout. The supported local wrappers are:

```bash
npm run wco -- --help
npm run control -- --help
npm run web-authority -- --help
npm run executor -- --help
```

If you prefer direct `wco`, `wco-control`, `wco-web-authority` and `wco-executor` commands on your PATH, `npm link` is optional after the build.

Before a real run, use the machine preflight. It does not require an existing run ID:

```bash
npm run doctor -- \
  --state-dir <state-dir> \
  --config <config.json>
```

`doctor` checks Node, state-directory access, trusted-config validity, configured credential environment keys, Git, the pinned bundled Codex version and local Codex authentication. It performs no model turn and prints no credential values. Add `--json` for automation.

## Primary durable workflow

1. Validate/intake/prepare the Task Bundle with `npm run wco -- ...`.
2. Register the exact Web implementation pack:

```bash
npm run web-authority -- register \
  --run-id <task-id>:<sha256> \
  --state-dir <state-dir> \
  --config <config.json> \
  --pack <implementation-pack.zip>
```

3. Let the durable controller advance as far as existing authority permits:

```bash
npm run control -- continue \
  --run-id <task-id>:<sha256> \
  --state-dir <state-dir> \
  --config <config.json> \
  [--web-pack <implementation-pack.zip>] \
  [--web-verdict <verdict.json>] \
  [--max-transitions <1..32>]
```

4. Inspect the run without starting model/network work:

```bash
npm run control -- status \
  --run-id <task-id>:<sha256> \
  --state-dir <state-dir>

npm run control -- next \
  --run-id <task-id>:<sha256> \
  --state-dir <state-dir>
```

Human output is concise by default. Add `--json` when a script needs the complete machine-readable receipt/ledger.

`continue` advances only transitions whose authority is already present. Missing Web pack/verdict is an input wait, not a failed retry. `WAIT_HUMAN` is the autonomous boundary. Pause/resume, retry backoff, transition locks, bounded budgets and recovery receipts survive restart; pause/resume never clears a durable terminal/budget block. Crash recovery runs before new input is read and adopts only exact already-completed lower-layer work.

Lower-level Phase 4–10 commands remain diagnostic/recovery surfaces (`wco execute`, `publish`, `create-draft-pr`, `package-result`, `submit-web-verdict`, `revise`, plus `wco-executor`).

## Performance and cost profile

The product is intentionally conservative at trust boundaries, but hot paths are bounded:

- inbox stability is observed in shared rounds rather than sleeping once per candidate; filesystem refresh is chunked with bounded concurrency;
- Git commands have hard local/network deadlines and bounded stdout/stderr; binary Git evidence uses the same bounded subprocess engine without UTF-8 conversion;
- archive/config/GitHub/model/result limits have trusted hard ceilings, and Task Bundle limits may only tighten effective work;
- model prompts/evidence are bounded and reviewers use fresh read-only threads; the implementer thread is resumed rather than replaying whole transcripts;
- durable ledger/event/diagnostic state is compacted and bounded;
- status/next commands do not start model work or enumerate Codex/browser history.

The full CI suite is intentionally heavier than normal operator reads because it exercises crash windows, locks, Git races and archive integrity in separate bounded test processes. See `PERFORMANCE.md` and `PRODUCT-AUDIT.md` for measured CI evidence and trade-offs.

## Validation gates

Fast development checks:

```bash
npm run typecheck
npm test
npm run build
```

Full final gate:

```bash
npm run phase16:release-gate
```

GitHub CI checks out the **exact PR head SHA**, asserts `git rev-parse HEAD` matches it, then runs template validation, typecheck, the full unit/fake suite, Phase 8 fake E2E, build and compiled CLI integrations.

## Security and recovery summary

- state/worktree/registry paths are confinement- and symlink-aware;
- untrusted and authority-defining reads are allocation-bounded and stable-read where applicable;
- selected Web authority and execution/review evidence are hash-bound;
- crash recovery adopts only exact registered/attested lower-layer states;
- stale/late results cannot complete a newer attempt;
- GitHub head/Draft/PR identity is freshly attested at publication/review boundaries;
- same-PR revision reuses the frozen accepted bundle and original path/verification/reviewer policy;
- subprocess output, diagnostics and state growth are bounded; secrets are excluded from result archives;
- trusted configuration may tighten resource/token limits but cannot exceed hard product safety ceilings.

## Local-only final checks

GitHub CI cannot prove native Windows/WSL/Codex/bridge behavior. Run `LOCAL-FINAL-CHECKLIST.md` on the target machine before calling the product locally release-ready.

`LICENSE`/distribution policy and any actual version/release publication remain explicit maintainer decisions; this repository does not choose or publish them automatically.
