# Operations and User Workflow

This guide answers the practical questions a WCO user has after reading the README: what to configure, what to run, what WCO is doing, why it may stop, and how to continue safely.

For architecture and security internals, see [Architecture](architecture.md) and [Protocols and Authority](protocols.md).

## The normal WCO workflow

Most users should think about WCO as this loop:

```text
prepare the task
      ↓
wco doctor
      ↓
wco preview task-bundle.zip
      ↓
wco run task-bundle.zip
      ↓
WCO works until it needs outside input
      ↓
provide the requested input
      ↓
wco run task-bundle.zip again
      ↓
Draft PR + result
      ↓
you decide whether to merge or revise
```

You normally do **not** need to drive the lower-level state machine step by step.

## 1. Prepare local configuration

Start from the example and keep real configuration outside Git:

```bash
mkdir -p .wco
cp examples/config.example.json .wco/config.json
```

A convenient layout is:

```text
.wco/
  config.json
  state/
```

The most important configuration sections are:

### `repositories`

This tells WCO which local repository it is allowed to work on and which remote URL it expects.

Check:

- `path` points to the real local repository;
- `remote` matches the Git remote name, normally `origin`;
- `expected_remote_urls` contains the remote you actually trust;
- `fetch_policy` matches how you want missing Git objects handled.

### `runtime`

WCO uses the Codex version bundled with the project. If you set `codex_home`, it must point to the Codex authentication directory you intend WCO to use.

### `agents`

This selects the implementation and review models and limits how much model work one run may consume.

The default example uses separate implementation/internal-review and final-review roles. The point is not the model names themselves; the point is that implementation is not accepted only because the same agent says its own code is good.

### `verification`

This is the command allow-list and resource limits for task verification.

If a task asks WCO to run a command that is not allowed here, WCO should stop instead of quietly running it anyway.

### `publish` and `github_pull_request`

These settings are used only for Git/GitHub publication steps. Keep real tokens in environment variables, not in the JSON file.

## 2. Set convenient shell defaults

Instead of repeating paths on every command:

```bash
export WCO_CONFIG="$PWD/.wco/config.json"
export WCO_STATE_DIR="$PWD/.wco/state"
```

After a run exists, you can also set:

```bash
export WCO_RUN_ID='<task-id>:<task-bundle-sha256>'
```

Flags such as `--config`, `--state-dir`, and `--run-id` still override these defaults.

## 3. Run `wco doctor`

Before giving WCO a real coding task:

```bash
wco doctor
```

`doctor` checks the things that are expensive or confusing to discover halfway through a run:

- Node and Git availability;
- trusted WCO configuration;
- the pinned Codex runtime;
- Codex authentication;
- required credentials when configured;
- whether the verification sandbox works with network disabled.

If the sandbox check fails, fix the environment first. WCO does not treat “sandbox unavailable” as permission to run verification unrestricted on the host.

## 4. Understand the Task Bundle before running it

A Task Bundle is the job WCO is being asked to carry out. It should answer questions such as:

- Which repository is this for?
- Which base revision does the task belong to?
- What is the requested change?
- Which files may change?
- Which files or behaviors must not change?
- What counts as success?
- Which commands must pass?

The current reference template is in `templates/task-bundle/`.

WCO does not currently create a complete Task Bundle from a single plain-language goal. The bundle may be authored by ChatGPT Web, another task-authoring workflow, or manually from the template.

You can validate a directory while authoring it:

```bash
wco validate ./my-task-bundle
```

When you have the archive that will actually be executed, preview it:

```bash
wco preview ./task-bundle.zip
```

`preview` is intentionally safe to run before committing to the workflow. It reports the target, allowed scope, checks, delivery policy, and human boundaries. It may store intake state, but it does not create the implementation worktree or start model/network work.

## 5. Start or continue with `wco run`

```bash
wco run ./task-bundle.zip
```

Think of `run` as “do everything that is currently safe and fully specified.”

It keeps advancing until one of these things happens:

- it needs an external input;
- it needs a human decision;
- a retry boundary has been reached;
- configuration/authentication/environment needs fixing;
- the workflow reaches a final state.

When `run` stops, read the reported next action instead of assuming the whole task failed.

## 6. Check progress with `wco status`

```bash
wco status
```

or explicitly:

```bash
wco status \
  --run-id '<task-id>:<bundle-sha256>' \
  --state-dir ./.wco/state
```

`status` is for questions such as:

- What task is this run for?
- What stage has completed?
- What is WCO waiting for?
- How many WCO-controlled model turns have been consumed?
- Is the run paused?
- Has publication or review completed?

Use `--json` where supported when another tool needs to read the status.

## 7. External inputs are expected, not hidden

WCO intentionally keeps some boundaries explicit.

Depending on the workflow, it may ask for an implementation pack produced outside the current WCO process or for a verdict over the exact Result Bundle.

Advanced automation can provide those explicitly, for example:

```bash
wco run ./task-bundle.zip --web-pack ./implementation-pack.zip
```

or:

```bash
wco run ./task-bundle.zip --web-verdict ./verdict.json
```

The important behavior is that WCO does not silently invent missing outside decisions just to keep the process moving.

## 8. What WCO checks before calling work “done”

WCO is built around a simple user expectation: a success message is not enough.

Before later stages rely on earlier work, WCO checks the real state again. In practical terms, this is intended to prevent situations like:

- tests passed on one version of the code, but a different version was pushed;
- review approved one change, but the Draft PR points at another commit;
- a branch or PR changed while the workflow was interrupted;
- an old local success record is reused even though the files changed;
- a crash causes a model call, push, or PR creation to be repeated blindly.

The implementation details live in the protocol docs; users mainly need to know that WCO prefers stopping over guessing when the evidence no longer matches.

## 9. If the process crashes or you close the terminal

For an ordinary interruption, run the same task again:

```bash
wco run ./task-bundle.zip
```

WCO stores enough state to check already-completed work and continue when it can prove that work is still valid.

It does not use an old terminal message or model transcript as the source of truth.

If an interruption happened during a provider-backed model call and WCO cannot prove whether that call completed, it fails closed instead of automatically spending another turn and hoping the duplicate is harmless.

## 10. Pause and resume

Pause prevents WCO from starting new transitions:

```bash
wco pause
```

Clear an explicit pause with:

```bash
wco resume
```

`resume` does not itself continue the job. Run the task again afterward:

```bash
wco run ./task-bundle.zip
```

This distinction matters after crashes: normal crash recovery happens when the next operation is attempted; `resume` is only for a run that you explicitly paused.

## 11. Draft PR and final decision

WCO can publish the checked change and create or re-check a GitHub Draft PR.

It deliberately does not expose automatic merge, Mark Ready, auto-merge, or branch-deletion authority as part of the autonomous workflow.

The intended end of the loop is:

```text
WCO verifies the result
        ↓
Draft PR + Result Bundle
        ↓
external review/verdict
        ↓
you decide whether to merge
```

A revision request can authorize another bounded round on the same PR; an approval still stops before the human merge decision.

## Common command map

For normal use:

```bash
wco doctor
wco preview ./task-bundle.zip
wco run ./task-bundle.zip
wco status
```

For authoring/inspection:

```bash
wco validate ./task-bundle-directory
wco next
```

For explicit control or automation:

```bash
wco pause
wco resume
wco continue
wco intake ./task-bundle.zip
wco scan
wco watch
```

`next` and `continue` are intentionally lower-level tools. Start with `run` unless you are debugging or building automation around WCO.

## Model usage and token limits

WCO tries to spend model work deliberately rather than treating every stage as one giant Codex conversation.

Before a provider-backed review call, WCO checks the limits it can know in advance, such as allowed turns and elapsed time. After a response returns, it records provider-reported token usage when available and can prevent later calls once configured continuation thresholds are reached.

There is an important limitation: the pinned Codex SDK does not give WCO a reliable hard output-token cap for the model call that is already in progress. For that reason WCO does **not** claim that its token settings are an exact billing ceiling for the current call.

Likewise, WCO is designed to avoid unnecessary Codex work, but the project does not claim a fixed token/cost saving percentage without a real provider-backed benchmark for the workload being discussed.

## Smart Context

Independent review does not need to treat every file in a large repository as equally relevant.

WCO can build a small, repeatable list of already-approved/read-covered paths that are likely to help reviewers understand the changed files. It never uses this list to expand what the task is allowed to change.

The offline benchmark:

```bash
npm run benchmark:context
```

measures only selector overhead and selected-path byte reduction. It does not claim provider token savings, latency savings, model-quality improvement, or task-success improvement.

A separate opt-in native benchmark exists for real provider-backed review calls and should only be run when you intentionally want to spend those model turns.

## State and backups

The WCO state directory is important application data. It contains the records WCO uses to continue and verify long-running work.

Practical rules:

- do not hand-edit WCO state while a run is active;
- do not concurrently sync/replace the state directory with tools that may swap files or links underneath WCO;
- back up state together with the corresponding repository if a long-running mission must survive machine loss;
- do not put secrets into Task Bundles, verdict files, or diagnostic logs.

## Native installation versus Docker

### Recommended today: native CLI

Native Node/Git integration is the primary target because WCO intentionally needs access to:

- host Git repositories and worktrees;
- local Git identity and credential helpers;
- Codex authentication/runtime state;
- GitHub credentials supplied by the operator environment;
- optional browser/bridge tooling that may live outside a container.

A container can still be useful for development or CI, but making Docker the default user runtime today would move much of the complexity into mounts, credential forwarding, file ownership, and host integration.

## Native pre-release validation

Hosted CI intentionally cannot prove your local Codex authentication, WSL/Git behavior, or native sandbox support.

For the current pre-release candidate, run:

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:native:sandbox
WCO_RUN_CODEX_INTEGRATION=1 npm run test:native:codex
```

The second test uses real provider-backed Codex execution. It should be an intentional opt-in action.

See [Development](development.md) for the full test matrix and release-candidate checks.

## Release path

The current release sequence is:

1. **Now:** source checkout for contributors and technical evaluators.
2. **Release candidate:** package artifact attached to a GitHub Release, with checksum and provenance/attestation.
3. **Stable CLI:** optional npm publication after supported native environments pass compatibility checks.
4. **Optional container:** only after the host-integration contract is clear enough to make it useful rather than misleadingly simple.

The package remains `private: true` during pre-release so an accidental `npm publish` cannot create an unsupported public release. `npm run pack:check` verifies the future distributable surface.

## Release integrity roadmap

For a public release, the project should add release-facing supply-chain evidence without weakening the current exact-head checks:

- SBOM generation for runtime dependencies;
- build provenance/artifact attestation;
- checksums for downloadable archives;
- a documented supported Node/OS matrix;
- dependency and code/security scanning with reviewed findings;
- protected/signed release tags or workflow where practical.
# v0.3 operator entry points

Run `wco setup` once from a target repository, then use `wco` for the interactive workflow. `/web status` verifies the Action relay connection; opening the GPT URL alone is not a connection proof. The TUI drives the same durable controller as `wco run` and `wco continue`, so restart recovery re-attests receipts instead of replaying uncertain model calls.

The reference dogfood relay is `wco web relay`, bound to loopback by default and authenticated with `WCO_RELAY_TOKEN`. A ChatGPT Web Action needs a separately hosted HTTPS endpoint. Keep OAuth/bearer credentials outside repositories.

Final APPROVE stops at `ASK_USER_TO_MERGE`. Mark Ready, merge, auto-merge, deployment and release remain manual.
