# Local Final Checklist

Run these only from the final Phase 16 branch in the user's real Windows/WSL/native Codex/codex-chatgpt-web environment. Do not merge or mark the PR Ready before returning the diagnostics.

## 1. Exact local head and clean tree

```bash
git fetch origin
git switch codex/phase-16-final-hardening-v2
git pull --ff-only
git rev-parse HEAD
git status --short
```

Return: the full HEAD SHA and complete `git status --short` output. The tree must be clean.

## 2. Reproduce the complete Phase 16 gate locally

```bash
npm ci
npm run phase16:release-gate
```

Return: final exit code plus the final test summary. If anything fails, return the failing command, test name and complete error/stack for that failure.

## 3. Native Codex sandbox integration

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:sandbox-integration
```

Return: exit code, test summary, Codex version, OS/WSL version, and any sandbox/auth diagnostic emitted by the test.

## 4. Native Codex execution integration

```bash
WCO_RUN_CODEX_INTEGRATION=1 npm run test:codex-integration
```

Return: exit code, test summary, Codex version, model/effort route actually selected if reported, and any auth/session/reconnect/usage diagnostic. Do not paste secrets or tokens.

## 5. Control-plane doctor in the real state/config environment

```bash
npm run build
node dist/orchestration/standalone-cli.js doctor \
  --run-id <REAL_RUN_ID> \
  --state-dir <REAL_WCO_STATE_DIR> \
  --config <REAL_WCO_CONFIG_JSON> \
  --json
```

Return: the complete bounded JSON doctor report after removing credentials/secrets only.

## 6. codex-chatgpt-web/native bridge smoke

With the bridge/runtime configuration you actually intend to use, start one normal health/smoke turn and one fresh-session turn using the supported upstream command for your installed bridge version. Do not invent flags from this repository.

Return exactly these observations: bridge version; Codex version; Windows + WSL version; transport/tool mode; advertised command/tool namespace if shown; whether a fresh session succeeds; whether a second sequential session succeeds; whether cleanup releases the prior session/tab; active/queued session counts before/during/after if exposed; wall time for each turn; and any disconnect/reconnect/cold-start/restart-loop message.

## 7. Bounded concurrency/backpressure smoke

Using the bridge's documented command for your installed version, run the smallest supported concurrent smoke that demonstrates the configured WCO/bridge limit without exceeding the bridge's advertised safety limit.

Return: configured limit, observed active/queued count, peak CPU/RAM if readily available from Task Manager/`top`, whether work queued instead of spawning unbounded sessions, whether all sessions were released afterward, and any rate-limit/backpressure error. Do not increase concurrency merely to stress the account/runtime.

## 8. Final result to return

Return one message containing: exact HEAD SHA; outputs requested in steps 1–7; and any discrepancy between documented capability and observed native behavior. Do not include API keys, cookies, auth headers, OAuth tokens, or full browser profiles.
