
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

Accepted bundles are stored under `.wco/accepted/<task-id>/<archive-sha256>/`.
Rejected archives and structured reports are stored under
`.wco/rejected/<archive-sha256>/`. Temporary quarantine directories are removed
after every operation.

Schema 1.0 directory bundles remain supported. Schema 1.1 ZIP bundles use the
canonical uppercase documentation files and require `checksums.json`.
