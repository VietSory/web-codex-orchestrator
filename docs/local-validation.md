# Local validation

Use this checklist only after deterministic GitHub CI and Advanced bridge compatibility are green for the **exact candidate head**. These checks exercise Linux/WSL, Bubblewrap, the bundled Codex runtime, real ChatGPT authorization, provider behavior, Git/GitHub delivery, restart/recovery, and the packed normal-user flow that GitHub CI cannot fully emulate.

The normal deterministic product path is **Linux/WSL only** for this build. Native Windows/macOS may be used to download files or inspect WSL status, but do not run normal WCO setup/auth/tasks there.

## 1. Linux/WSL environment preflight

If starting from Windows, PowerShell is only used to confirm WSL exists:

```powershell
wsl.exe --status
```

Then enter WSL and run every remaining command there from the WCO candidate repository unless a step explicitly says to switch to the separate dogfood repository:

```bash
node --version
npm --version
git --version
bwrap --version
gh auth status
```

Requirements for the normal path:

- Node.js 22+
- npm
- Git
- Bubblewrap (`bwrap`)
- GitHub CLI (`gh`) authenticated before Draft-PR delivery
- one normal ChatGPT authorization through WCO's bundled official Codex runtime

Do not configure an OpenAI API key, relay, tunnel, domain, Custom GPT, MCP connector, Workspace Agent, or manual ZIP handoff for the normal acceptance path.

## 2. Exact-source deterministic gate

Record the candidate identity first:

```bash
git rev-parse HEAD
git status --short
```

The HEAD must equal the exact GitHub-qualified PR head and the working tree must be clean.

Run:

```bash
npm ci
npm run validate:template
npm run typecheck
npm test
npm run benchmark:context
npm run benchmark:web-context
npm run benchmark:prompt-footprint
npm run benchmark:semantic
npm run test:e2e
npm run build
npm run test:cli
npm run test:user:contract
npm run pack:check
npm run pack:smoke
```

`npm run benchmark:semantic` is the deterministic hidden-gold corpus/scorer integrity gate. It does not call a provider and does not claim model uplift; it prevents a broken corpus/scorer from being used as release evidence later.

`npm run pack:smoke` is a release gate, not a convenience smoke. It packs WCO, installs the tarball without dev dependencies, runs the installed `wco` binary through a real PTY, and exercises fresh/returning use plus blocked prerequisites and terminal-control recovery.

Every command above must pass before provider-backed acceptance.

## 3. Native sandbox and bundled-Codex integration

Run the opt-in host integrations inside Linux/WSL:

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:native:sandbox
WCO_RUN_CODEX_INTEGRATION=1 WCO_KEEP_FAILED_INTEGRATION=1 npm run test:native:codex
```

These tests may create real provider-backed turns. If the Codex integration fails, keep the printed `WCO_FAILED_INTEGRATION_ROOT=` / `WCO_FAILED_INTEGRATION_STATE=` paths only for local diagnosis. Never share tokens, cookies, credential files, `~/.codex`, browser profiles, or other authorization material.

## 4. Authorized semantic-provider benchmark

Run the provider benchmark only after the deterministic/native gates pass:

```bash
npm run benchmark:semantic:provider
```

Treat this as task-quality evidence, not merely a latency/token measurement. The benchmark must preserve exact input/evidence binding and report the provider-backed quality/usage evidence required by the benchmark contract. Static prompt byte counts or offline context-cache hits are not substitutes for this gate.

The command is fail-closed for release qualification. Its JSON report contains `qualification.pass`, `qualification.reasons`, per-arm usage, token delta, and newly introduced/resolved critical misses. The command must exit successfully with `qualification.pass: true`. It exits non-zero when the independent challenger introduces a new critical miss, regresses aggregate critical recall, regresses aggregate weighted quality, or spends more total provider tokens than the author-style baseline without any measured semantic gain. No arbitrary percentage tolerance is used; the baseline is the quality/safety floor and the configured agent limits remain the absolute resource ceiling.

Because this is one fresh provider sample per case/arm, preserve the exact output as directional evidence rather than claiming statistical certainty or end-to-end task-completion uplift.

## 5. Packed normal-user dogfood

Build the exact candidate tarball from the clean qualified head:

```bash
npm pack
```

Install that generated `.tgz` **inside Linux/WSL**. Then change to a separate real GitHub repository that is safe for dogfood. Do not run the acceptance task in the WCO source repository itself.

For a clean install, remove/replace any older WCO global installation as appropriate, install the candidate tarball, then confirm the installed CLI responds:

```bash
npm install -g /absolute/path/to/web-codex-orchestrator-*.tgz
wco --version
```

The candidate package can still carry the previous published package version until release identity is deliberately bumped; bind acceptance to the recorded tarball digest and Git HEAD rather than inferring candidate identity from the version string alone.

## 6. Real first-use journey

Inside the separate dogfood repository:

```bash
cd /path/to/dogfood-repository
wco
```

The expected normal-user flow is:

```text
wco
  -> Linux/WSL + repository setup/preflight
  -> official ChatGPT authorization once, if needed
  -> interactive WCO prompt
  -> user goal
  -> exact repository reads
  -> sealed plan/contract
  -> Codex implementation proposal
  -> WCO isolated mutation + deterministic verification/repair
  -> independent semantic review/revise
  -> reviewed Draft PR
  -> READY_FOR_YOU
  -> human decides whether to merge
```

A normal user must not be asked for API keys, relay/tunnel/domain setup, Custom GPT configuration, MCP/Workspace Agent setup, internal run IDs, or manual task/result ZIP transfer.

Use a goal large enough to require real repository understanding and verification, not a one-line cosmetic edit. Record the exact goal and the base commit before starting.

## 7. Break the real user flow on purpose

Do not accept only the happy path. Exercise these behaviors through the installed packed `wco` binary where safe:

- start from a repository without a valid remote and verify WCO stops with an actionable recovery message before creating trusted task authority;
- verify `wco doctor` explains a missing prerequisite rather than exposing an internal error;
- while composing input, Ctrl+C cancels only the draft and keeps WCO open;
- Ctrl+D from an empty prompt exits safely;
- `/pause` stops at a safe boundary and preserves progress;
- restart `wco` and verify `/continue` continues **only the current saved task**;
- verify `/resume` opens saved-task selection and does not silently replace `/continue` semantics;
- when practical, open a second WCO process against the same repository and verify stale focus/confirmation cannot overwrite the current task;
- interrupt/restart around a durable workflow boundary and verify WCO resumes from receipts instead of replaying an ambiguous provider/mutation action.

Do not deliberately destroy credentials, rewrite remote history, force-push, merge, or release as part of these break tests.

## 8. Draft-PR and review acceptance

The real task is accepted only when all of the following are bound to the same run/change-set:

- exact base commit and repository identity;
- exact sealed task/acceptance evidence;
- implementation and verification receipts;
- independent review evidence, including any revise loop that occurred;
- exact published commit/remote head;
- one reviewed **Draft PR**;
- final state `READY_FOR_YOU`;
- no automatic merge or release.

Inspect `/status` and `/review` during the task. They must tell the user what WCO is doing and, when applicable, exactly what **Your action** is. A successful run must not require the user to understand internal phase names to proceed.

## 9. Restart/recovery proof

Before calling the candidate locally qualified, perform at least one real restart/recovery check on saved progress. After restarting WCO:

- the same repository/task identity is recovered;
- `/continue` does not jump to unrelated history;
- `/resume` requires explicit saved-task choice;
- already completed provider/mutation/publish authority is not duplicated;
- the same Draft PR is rediscovered/reused where recovery applies;
- no second conflicting branch/PR/semantic authority is created.

## 10. Record acceptance evidence

Record at minimum:

```text
candidate Git HEAD
tarball filename + SHA-256
Linux/WSL environment
Node/npm/Git/Bubblewrap versions
GitHub auth readiness (never the token)
provider benchmark result + qualification.pass/reasons + per-arm token totals
real user goal
repository + exact base commit
run/task identity
published commit
Draft PR URL/status
verification result
independent review/final verdict
restart/recovery result
/continue and /resume result
any revise round count
final READY_FOR_YOU result
```

Do not record or share ChatGPT/Codex credentials, cookies, browser-profile data, GitHub tokens, relay secrets, or other private authentication material.

## Release boundary

Passing GitHub CI alone means **GitHub-side qualified**, not release-qualified. Passing this entire authorized Linux/WSL checklist is the environment-bound acceptance required before recommending release.

Even after acceptance, WCO must leave the PR as Draft until a human deliberately changes that state. WCO must never merge, tag, release, enable auto-merge, or force-push on behalf of this validation checklist.
