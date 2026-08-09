# Web Codex Orchestrator

[![CI](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml)

**Spend Codex on coding. Get a second opinion. Verify the result before it reaches you.**

Web Codex Orchestrator (WCO) is a local CLI for larger AI-assisted coding jobs. It coordinates the handoff between a task definition, Codex implementation, independent review, automated checks, GitHub Draft PR delivery, and your final decision.

> Status: pre-release. WCO is ready for development and technical evaluation, but a stable public package has not been released yet.

## Why WCO instead of using Codex directly?

For a small bug, quick refactor, or interactive coding session, **use Codex directly**. WCO is not meant to replace that workflow.

WCO is useful when the job is large enough that you do not want one Codex session to do everything and then grade its own work.

The idea is simple:

```text
ChatGPT Web / task author
    research, plan, define the job
                ↓
               WCO
                ↓
Codex implementer
    focus on making the change
                ↓
Automated checks
    prove required commands pass
                ↓
Independent reviewers
    look for mistakes in the result
                ↓
               WCO
    verify the code, Git state and Draft PR
                ↓
               You
    merge, request a revision, or stop
```

WCO is designed to give you four practical benefits:

1. **Use Codex where it matters most.** Research and planning can happen outside the implementation turn, so Codex does not need to rediscover the whole problem every time.
2. **Get a second opinion.** The implementation is checked by separate review steps instead of relying only on the agent that wrote the code.
3. **Stop babysitting the workflow.** WCO keeps track of what has already happened, runs checks, moves between steps, and tells you when it actually needs input.
4. **Do not trust a simple “Done.”** WCO checks the real files, test result, reviewed change, Git commit, remote branch, and Draft PR before treating a step as complete.

WCO does **not** claim a guaranteed percentage of token or cost savings. The current design is intended to avoid unnecessary model work and to measure model usage where the provider reports it; real savings depend on the task and workflow.

## When should I use WCO?

Use WCO when you have a task such as:

- a multi-file feature or refactor;
- a long job that may take several implementation/review rounds;
- a repository where changing the wrong files would be risky;
- work where you want a separate reviewer before accepting the result;
- a workflow that should survive a terminal or process interruption;
- a change that should end as a verified Draft PR instead of an automatic merge.

Use Codex directly when you are pair-programming, exploring, prototyping, fixing a small issue, or simply want the fastest interactive loop.

## What do I give WCO, and what do I get back?

### Input: a Task Bundle

A **Task Bundle** is the job description WCO accepts. It tells WCO what repository and base state the task belongs to, what may change, what must not change, what “done” means, and which commands must pass.

The reference shape lives in [`templates/task-bundle/`](templates/task-bundle/).

A Task Bundle can be prepared by ChatGPT Web, another trusted task-authoring workflow, or manually from the template. WCO does not currently turn one plain-English sentence into a full Task Bundle by itself.

Before any repository work starts, you can inspect the bundle with:

```bash
wco preview ./task-bundle.zip
```

### Output: a checked result and Draft PR

A successful workflow can produce:

- the exact code change;
- required verification results;
- independent review results;
- a Git commit and delivery branch;
- a GitHub **Draft** pull request;
- a Result Bundle containing the evidence for the exact published result.

WCO deliberately does not merge the pull request for you. The final merge decision stays with a human.

## What happens after I run it?

At a high level WCO does this:

```text
1. Read and validate the task
2. Prepare an isolated place to work
3. Accept the exact implementation input for that task
4. Apply the change and run the required checks
5. Ask independent reviewers to inspect the same final change
6. If review finds a fixable problem, run a bounded revision loop
7. Publish only the checked change to the configured branch
8. Create or re-check the Draft PR
9. Produce the result for external review
10. Stop and let you decide what happens next
```

If WCO is interrupted, it does not simply assume the previous step succeeded and it does not blindly start over. On the next run it checks what really exists and continues only from work it can verify.

## Requirements

- Node.js 22 or newer
- npm
- Git
- a local Git repository registered in WCO configuration
- Codex authentication for model-backed implementation/review paths
- GitHub credentials only when the workflow needs to publish or attest a Draft pull request

Linux and WSL are the primary development environments today. Native behavior that depends on local Codex, Git, credentials, and sandbox support should be tested on the machine where you plan to use WCO.

## Quick start from source

Clone and build WCO:

```bash
git clone https://github.com/VietSory/web-codex-orchestrator.git
cd web-codex-orchestrator
npm ci
npm run build
npm link
wco --help
```

`npm link` is optional. Without it, run commands from the checkout with `npm run wco -- <command>`.

Create local configuration:

```bash
mkdir -p .wco
cp examples/config.example.json .wco/config.json
```

Edit `.wco/config.json`. At minimum, check these parts carefully:

- `repositories`: the local repository WCO may work on and the expected remote URL;
- `runtime.codex_home`: your Codex authentication directory when you use an explicit one;
- `agents`: the models and limits for implementation/review;
- `verification`: which commands are allowed to run;
- `publish` and `github_pull_request`: credentials used only for Git/GitHub publication steps.

Set convenient defaults for the current shell:

```bash
export WCO_CONFIG="$PWD/.wco/config.json"
export WCO_STATE_DIR="$PWD/.wco/state"
```

Check the machine before starting real work:

```bash
wco doctor
```

`doctor` checks the local runtime, configuration, Codex availability/authentication, and verification sandbox. A failed sandbox check is a failed preflight; WCO does not silently fall back to unrestricted execution.

Preview the task before it touches the repository:

```bash
wco preview ./task-bundle.zip
```

Then start or continue the workflow:

```bash
wco run ./task-bundle.zip
```

Check progress at any time:

```bash
wco status --run-id '<task-id>:<bundle-sha256>'
```

Once you know the run ID, you can set it once:

```bash
export WCO_RUN_ID='<task-id>:<bundle-sha256>'
wco status
```

## What if WCO stops and asks me for something?

That can be normal. WCO intentionally stops at boundaries where an external result or a human decision is required.

For example, it may need:

- an implementation pack produced outside the current WCO process;
- a review verdict for the exact Result Bundle;
- corrected configuration or credentials;
- a retry after an external service failure;
- a human decision after the Draft PR is ready.

The CLI reports the next required input. Advanced workflows can provide inputs explicitly, for example with `--web-pack <zip>` or `--web-verdict <json>`.

WCO is therefore **not** currently a “type one goal, close the laptop, and let it build any project by itself” product. It is a controlled workflow that automates the repeatable implementation, checking, review, recovery, and publication steps while keeping explicit outside decisions explicit.

## What if my terminal or process crashes?

Run the same task again:

```bash
wco run ./task-bundle.zip
```

WCO keeps durable state and checks completed work before continuing. If it cannot prove what happened around a model call or external side effect, it stops instead of guessing or repeating the action automatically.

If you explicitly paused a run, clear the pause first:

```bash
wco resume
wco run ./task-bundle.zip
```

`resume` only removes the pause. `run` is what continues the workflow.

## Common commands

```text
wco doctor       check machine, config, Codex auth and sandbox
wco preview      inspect a task before repository work starts
wco run          prepare or continue the main workflow
wco status       show current progress and recorded runtime evidence
wco pause        prevent new transitions
wco resume       clear an explicit pause
wco next         show the next durable transition without running it
wco continue     lower-level transition runner for automation/debugging
wco validate     validate a Task Bundle directory
wco intake       securely ingest a Task Bundle archive
wco scan/watch   process an inbox of Task Bundles
```

Use `--json` where supported for machine-readable output.

## What WCO deliberately does not do

- It does not replace Codex; Codex remains the coding engine on model-backed paths.
- It does not replace ChatGPT Web or another task author; those can still research and define the job.
- It does not treat a chat transcript or old success message as proof that a workflow step completed.
- It does not let reviewers silently invent new file changes.
- It does not expose automatic merge, Mark Ready, auto-merge, or branch-deletion authority.
- It does not claim provider cost/token savings that have not been measured on real workloads.

## Native validation for this pre-release

Hosted CI covers the deterministic test suite, build, CLI integrations, workflow tests, and offline Smart Context benchmark. Real Codex authentication and the native verification sandbox must still be checked on a target machine:

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:native:sandbox
WCO_RUN_CODEX_INTEGRATION=1 npm run test:native:codex
```

See [Development](docs/development.md) for the complete test and release-candidate policy.

## Want the technical details?

The README is intentionally user-first. Deeper implementation and security details live here:

- [Operations and user workflow](docs/operations.md)
- [Architecture](docs/architecture.md)
- [Protocols and authority](docs/protocols.md)
- [Development](docs/development.md)
- [Security policy](SECURITY.md)

## Packaging

Native CLI installation is the primary target because WCO needs direct access to local Git worktrees, Codex authentication, credentials, and optional host tooling. The repository verifies its future package surface with `npm pack --dry-run`.

The intended release sequence is GitHub release artifacts first, followed by optional npm publication after native compatibility checks are stable. See [Operations](docs/operations.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
