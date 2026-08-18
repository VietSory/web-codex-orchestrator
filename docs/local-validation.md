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
npm run benchmark:relay-efficiency
npm run benchmark:prompt-footprint
npm run benchmark:semantic
npm run test:e2e
npm run build
npm run test:cli
npm run test:user:contract
npm run pack:check
npm run pack:smoke
```

`npm run benchmark:relay-efficiency` compares WCO's bounded/cache-aware context transfer with an explicit naive/manual full-context retransmission baseline. It is context-transfer evidence only: byte counts must never be presented as provider-token counts or task-quality evidence.

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

## 4. Authorized provider quality and review-value benchmarks

Run both provider benchmarks only after the deterministic/native gates pass:

```bash
npm run benchmark:semantic:provider
npm run benchmark:review:provider
```

`npm run benchmark:semantic:provider` is task-understanding/token evidence, not merely a latency measurement. It must preserve exact input/evidence binding and report the provider-backed quality/usage evidence required by the benchmark contract. Static prompt byte counts or offline context-cache hits are not substitutes for this gate.

The semantic-provider command is fail-closed for release qualification. Its JSON report contains `qualification.pass`, `qualification.reasons`, per-arm usage, token delta, and newly introduced/resolved critical misses. The command must exit successfully with `qualification.pass: true`. It exits non-zero when the independent challenger introduces a new critical miss, regresses aggregate critical recall, regresses aggregate weighted quality, or spends more total provider tokens than the author-style baseline without any measured semantic gain. No arbitrary percentage tolerance is used; the baseline is the quality/safety floor and the configured agent limits remain the absolute resource ceiling.

`npm run benchmark:review:provider` is the independent-review value gate. It presents a realistic changed implementation whose visible direct test passes while an unchanged caller contains the hidden regression surface, plus a clean twin that should not be rejected merely because the reviewer is adversarial. Release qualification requires the provider reviewer to request exact immutable repository source as needed, return `REVISE` for the hidden-caller defect, return `APPROVE` for the clean twin, stay within the bounded lookup/turn budget, and exit successfully. A reviewer that merely trusts green tests/diff evidence, or one that blindly rejects everything, fails this gate.

Because these are fresh provider samples rather than a statistically large trial, preserve the exact outputs as directional release evidence rather than claiming universal model superiority. Both commands must pass on the exact candidate used for dogfood.

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

A normal user must not be asked for API keys, relay/tunnel/domain setup, Custom GPT configuration, MCP/Workspace Agent setup, internal run IDs, manual task/result ZIP transfer, or manual ChatGPT↔Codex payload relay.

**User-value acceptance requires `manual ChatGPT↔Codex payload copy/paste = 0`.** The user may enter the original goal, answer a genuine clarification, inspect status/review evidence, and make the final human merge decision. The user must not have to copy model prompts, repository context, implementation payloads, test output, review findings, repair instructions, or result bundles from one agent/interface into another. If such a handoff is required to finish the task, the dogfood run fails even if a Draft PR is eventually produced.

Use a goal large enough to require real repository understanding, unchanged-caller/call-graph reasoning, verification, and at least one meaningful independent review decision, not a one-line cosmetic edit. Record the exact goal and the base commit before starting.

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
- independent review evidence, including exact immutable source inspection when required and any revise loop that occurred;
- exact published commit/remote head;
- one reviewed **Draft PR**;
- final state `READY_FOR_YOU`;
- manual ChatGPT↔Codex payload copy/paste count is exactly `0`;
- no automatic merge or release.

Inspect `/status` and `/review` during the task. They must tell the user what WCO is doing and, when applicable, exactly what **Your action** is. A successful run must not require the user to understand internal phase names to proceed.

Do not count a run as successful merely because the Draft PR is created or automated tests are green. Inspect the final Draft PR from the user's perspective and confirm that the independent review actually challenged the implementation, resolved material findings before approval, and left no known blocking defect in the accepted goal. Any material bug discovered during this acceptance returns the candidate to code/review qualification; it is not waived as a dogfood inconvenience.

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
semantic provider benchmark result + qualification.pass/reasons + per-arm token totals
review provider benchmark result + hidden-caller verdict + clean-twin verdict + lookup/turn/token totals
relay-efficiency context-transfer result + declared baseline (never label bytes as tokens)
manual ChatGPT↔Codex payload copy/paste count (must be 0)
real user goal
repository + exact base commit
run/task identity
published commit
Draft PR URL/status
verification result
independent review/final verdict + exact-source lookup evidence
restart/recovery result
/continue and /resume result
any revise round count
final READY_FOR_YOU result
```

Do not record or share ChatGPT/Codex credentials, cookies, browser-profile data, GitHub tokens, relay secrets, or other private authentication material.

## Release boundary

Passing GitHub CI alone means **GitHub-side qualified**, not release-qualified. Passing this entire authorized Linux/WSL checklist is the environment-bound acceptance required before recommending release.

The release-value claim is deliberately narrower than “WCO is universally better than every possible manual workflow.” Qualification means that, on the declared baselines and real dogfood task, WCO reduced repeated context relay, stayed within measured provider token/quality gates, independently detected the hidden-caller regression without rejecting the clean twin, completed the task with zero manual inter-agent payload copy/paste, and produced a reviewed Draft PR with no known blocking defect. Broader superiority claims require broader evidence.

Even after acceptance, WCO must leave the PR as Draft until a human deliberately changes that state. WCO must never merge, tag, release, enable auto-merge, or force-push on behalf of this validation checklist.
