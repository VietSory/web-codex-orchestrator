# Web Codex Orchestrator

Web Codex Orchestrator validates task bundles and provides a secure intake
boundary for ZIP files downloaded from ChatGPT Web. Intake is deliberately a
metadata-only operation: it never runs `payload/`, executes validation
commands, calls Codex, accesses the network, or changes Git remotes.

## Commands

```bash
npm ci
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
  --run-id TASK-2026-003:<task-bundle-sha256> \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json \
  --json

node dist/cli/index.js execution-status \
  --run-id TASK-2026-003:<task-bundle-sha256> \
  --state-dir ~/.local/state/web-codex-orchestrator --json

node dist/cli/index.js publish \
  --run-id TASK-2026-003:<task-bundle-sha256> \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json \
  --json

node dist/cli/index.js create-draft-pr \
  --run-id TASK-2026-003:<task-bundle-sha256> \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json \
  --json

node dist/cli/index.js package-result \
  --run-id TASK-2026-003:<task-bundle-sha256> \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json --json

node dist/cli/index.js submit-web-verdict \
  --run-id TASK-2026-003:<task-bundle-sha256> \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json \
  --verdict ./downloads/web-review-verdict.json --json

node dist/cli/index.js web-review-status \
  --run-id TASK-2026-003:<task-bundle-sha256> \
  --state-dir ~/.local/state/web-codex-orchestrator --json

# Phase 8: execute an already-sealed Phase 7 REVISE request.
node dist/cli/index.js revise \
  --run-id TASK-2026-003:<task-bundle-sha256> \
  --round 1 \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --config ~/.config/web-codex-orchestrator/config.json \
  --json

node dist/cli/index.js revision-status \
  --run-id TASK-2026-003:<task-bundle-sha256> \
  --round 1 \
  --state-dir ~/.local/state/web-codex-orchestrator \
  --json
```

The delivery order is intentional: `execute` must reach `READY_FOR_PUBLISH`,
then `publish` must reach `PUSHED`, then `create-draft-pr` must reach `OPEN`
before `package-result` can produce the exact Result Bundle for Web review.
Phase 7 processes only the registered Web verdict for that exact bundle and
never mutates GitHub.

If Phase 7 seals a `REVISE` decision, Phase 8 consumes only that canonical
revision request. `revise` re-attests the accepted Task Bundle, canonical
worktree, exact previous PR head, configured remote, and the same open,
unmerged Draft PR. It performs the bounded correction, deterministic
verification, Terra review, and Sol review; then it appends exactly one normal
commit and performs a normal fast-forward push to the existing PR branch. It
never creates another PR, force-pushes, marks the PR Ready, or merges it.

After publication, Phase 8 creates a deterministic Result Bundle v1.2 containing
both cumulative repository evidence and the exact previous-head-to-new-head
revision delta. Web review round 2 reads revision bundle 1, round 3 reads
revision bundle 2, and round 4 reads revision bundle 3. There is no fallback to
an older Result Bundle. The v1.2 receipt is hash-bound to the exact previous
Result Bundle receipt/archive, Web verdict, revision request, previous commit,
and previous PR head before Phase 7 may accept the next verdict.

A completed Phase 8 round ends in `RESULT_READY`; the user still decides whether
to merge only after a later Phase 7 `APPROVED` decision. `revision-status` is a
read-only status command. Revision rounds are limited to 1..3, matching Web
review rounds 2..4.

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
Production uses the pinned `@openai/codex@0.145.0` and
`@openai/codex-sdk@0.145.0` packages. WCO launches the bundled CLI launcher;
the user's global `codex` installation and its version are irrelevant. The
bundled runtime performs bounded `--version` and `login status` preflight
before any real turn. Authentication is read from the configured `CODEX_HOME`,
or from inherited HOME behavior when `codex_home` is omitted. The verifier runs
through the pinned sandbox contract:
`codex -c sandbox_workspace_write.network_access=false sandbox
--permission-profile :workspace --cd <canonical-cwd> -- <executable> <args>`.
There is no unsandboxed fallback. The accepted bundle is prompt context, never
an additional writable SDK directory. Normal CI uses fakes and consumes no
Codex usage. The optional real sandbox gate is
`WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:sandbox-integration`; the optional
real Phase 4 integration consumes Codex usage only when
`WCO_RUN_CODEX_INTEGRATION=1` is set. Phase 4 never commits, pushes, creates a
product PR, executes a payload, or contacts the public network.

Production configuration is trusted local input:

```json
{
  "runtime": {
    "source": "bundled",
    "codex_home": "/home/user/.codex"
  }
}
```

The global `codex` executable is not used, and no executable override
environment variable is required. For a local Phase 4 release gate:

```bash
WCO_CODEX_HOME="$HOME/.codex" npm run phase4:release-gate
```

For the Phase 7 release gate:

```bash
npm run phase7:release-gate
```

For the Phase 8 release gate, including the full fake same-PR revision loop:

```bash
npm run phase8:release-gate
```
