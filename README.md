
# Web Codex Orchestrator

Web Codex Orchestrator validates task bundles and provides a secure intake
boundary for ZIP files downloaded from ChatGPT Web. Intake is deliberately a
metadata-only operation: it never runs `payload/`, executes validation
commands, calls Codex, accesses the network, or changes Git remotes.

## Commands

```bash
npm install
npm run validate -- ./templates/task-bundle
npm run typecheck
npm test
npm run build

node dist/cli/index.js intake ./downloads/wco-task-207.zip --state-dir ./.wco
node dist/cli/index.js intake ./downloads/wco-task-207.zip --state-dir ./.wco --json
```

For regular use, keep state outside the repository so quarantined downloads
cannot be accidentally added to source control:

```bash
node dist/cli/index.js intake ./downloads/wco-task-207.zip \
  --state-dir ~/.local/state/web-codex-orchestrator

node dist/cli/index.js prepare ./downloads/wco-task-207.zip \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json

node dist/cli/index.js scan \
  --inbox ~/Downloads/web-codex-inbox \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json

node dist/cli/index.js watch \
  --inbox ~/Downloads/web-codex-inbox \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json \
  --jsonl

node dist/cli/index.js execute \
  --run-id TASK-2026-003:<archive-sha256> \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json \
  --json

node dist/cli/index.js execution-status \
  --run-id TASK-2026-003:<archive-sha256> \
  --state-dir ~/.local/state/web-codex-orchestrator --json
```

Add `--json` to `scan` for one machine-readable result object. Without it,
`scan` prints a short human-readable summary; diagnostics remain on stderr.

Accepted bundles are stored under `.wco/accepted/<task-id>/<archive-sha256>/`.
Rejected archives and structured reports are stored under
`.wco/rejected/<archive-sha256>/`. Temporary quarantine directories are removed
after every operation.

Schema 1.0 directory bundles remain supported. Schema 1.1 ZIP bundles use the
canonical uppercase documentation files and require `checksums.json`.
Schema 1.2 adds the execution, delivery, and Git policy contract. Schema 1.3
adds structured validation commands and the Phase 4 execution boundary.
Intake accepts 1.0 through 1.3; Phase 3 prepares 1.2/1.3, while Phase 4
executes only 1.3.

Phase 3 stores run receipts and isolated worktrees below the configured state
directory. The registry in `examples/config.example.json` is trusted local
configuration: bundle manifests contain only logical repository IDs, never
filesystem paths. Preparation verifies the remote and exact base commit, then
stops at `READY_FOR_CODEX`; it does not execute payloads or validation commands,
create commits, push, call GitHub, or invoke Codex.

Preparation uses an isolated Git runtime under `git-runtime/` (empty global
configuration and hooks), rejects repositories with external smudge/process
filters, and creates the worktree detached before attaching its validated local
branch. Credential-bearing HTTP(S) registry URLs are rejected and persisted
remote URLs are sanitized.

Phase 4 uses injected fake agents and verification sandboxes in normal tests.
The production adapter fails closed when a supported Codex runtime or sandbox
is unavailable. It never commits, pushes, creates a product PR, executes a
payload, or contacts the public network.
