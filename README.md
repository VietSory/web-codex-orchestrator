
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
```

Accepted bundles are stored under `.wco/accepted/<task-id>/<archive-sha256>/`.
Rejected archives and structured reports are stored under
`.wco/rejected/<archive-sha256>/`. Temporary quarantine directories are removed
after every operation.

Schema 1.0 directory bundles remain supported. Schema 1.1 ZIP bundles use the
canonical uppercase documentation files and require `checksums.json`.
Schema 1.2 adds the execution, delivery, and Git policy contract. Intake still
accepts 1.0 and 1.1, but only 1.2 can be prepared.

Phase 3 stores run receipts and isolated worktrees below the configured state
directory. The registry in `examples/config.example.json` is trusted local
configuration: bundle manifests contain only logical repository IDs, never
filesystem paths. Preparation verifies the remote and exact base commit, then
stops at `READY_FOR_CODEX`; it does not execute payloads or validation commands,
create commits, push, call GitHub, or invoke Codex.
