# LOCAL FINAL CHECKLIST

Run from Windows/WSL in the Phase 16 checkout and return the complete output/diagnostics requested below.

```bash
git status --short --branch
git rev-parse HEAD
node --version
npm --version
git --version
npm ci
npm run phase16:release-gate
```

Return: `git status --short --branch`, `git rev-parse HEAD`, tool versions, and the complete failing command/output if the release gate is not PASS.

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:sandbox-integration
```

Return: complete test output, including Codex/sandbox version, exit code and any stderr on failure.

```bash
WCO_RUN_CODEX_INTEGRATION=1 npm run test:codex-integration
```

Return: complete test output, including runtime/thread diagnostics, exit code and any sanitized stderr on failure.

With a real prepared run, set the exact local paths/ID and run:

```bash
export RUN_ID='<task-id>:<task-bundle-sha256>'
export WCO_STATE='<absolute-state-directory>'
export WCO_CONFIG='<absolute-config-json>'
npm run build
node dist/orchestration/standalone-cli.js doctor --run-id "$RUN_ID" --state-dir "$WCO_STATE" --config "$WCO_CONFIG" --json
node dist/orchestration/standalone-cli.js status --run-id "$RUN_ID" --state-dir "$WCO_STATE" --json
```

Return: both complete JSON outputs. Do not send tokens, credentials, raw Codex transcripts or private task contents.

If `codex-chatgpt-web` is part of the local deployment, run its documented native health/smoke command for the installed version and one bounded fresh-session turn plus one explicit-session resume turn. Return only: bridge version, Codex version, transport/tool mode, advertised capability/tool names, active/queued counts, pass/fail timings, exit codes and sanitized errors; do not return transcript content or credentials.
