# Operations and user workflow

This guide separates the normal interactive product from the lower-level automation surface. Daily users should not create WCO artifacts or maintain internal IDs.

## Normal interactive workflow

Install the checksummed Latest GitHub release as described in the repository README. Then enter a repository and run:

```bash
wco
```

First-run setup detects the canonical Git root, the deterministic remote (`origin` when present), the current/base branch, project tools, Codex readiness and GitHub CLI readiness. It writes only WCO-owned data under the platform user-data location:

- Linux/WSL: `$XDG_DATA_HOME/wco` or `~/.local/share/wco`;
- macOS: `~/Library/Application Support/wco`;
- Windows: `%LOCALAPPDATA%\WCO`.

`WCO_HOME` may override this for isolated testing or advanced operation. Normal users do not set `WCO_CONFIG`, `WCO_STATE_DIR` or `WCO_RUN_ID`.

### First connection and task

First run asks for Personal, Managed or Manual transport; Personal is recommended. Personal uses one Custom GPT Action, a Bearer-authenticated bounded mailbox and outbound local polling. It requires no OAuth, managed account/device, custom domain or inbound workstation port. Managed retains the expiring replay-protected device/OAuth path for organizations. Manual remains offline.

Personal users perform one explicit GPT-editor import after `wco web setup --personal`; WCO generates the exact files and never logs the secret. Users never edit WCO JSON or paste secrets into chat/task text. Invalid metadata, authentication failures, malformed responses and offline services leave repository files and workflow authority unchanged.

WCO creates the authoring job and opens the GPT. The hosted UI may require one click to start the pending WCO task. Repository inspection is bounded to exact Git objects at the sealed base; `.git/**`, `.env` and sensitive paths are denied. Search/read receipts become part of local authority validation.

The Web actor seals a testable contract and implementation submission. WCO materializes them locally into canonical internal artifacts, validates them, prepares an isolated worktree, applies exact preimages, and runs allowed commands in the pinned network-disabled sandbox. PAIR uses an independent Web-B review and no model reviewer. AUTOPILOT uses exactly one frozen Sol/Terra review by default, including any bounded repair in that same response.

Only the exact verified/reviewed result may be committed and normally pushed to the configured delivery branch. WCO creates or reuses one Draft PR. It does not force-push, push to a protected base, mark ready, merge, delete branches or deploy.

Final Web review is bound to the exact Result Bundle and published commit. APPROVE ends at the human merge boundary. REVISE performs a bounded same-PR revision with fresh verification and review. ESCALATE stops for a human.

## Returning user

```bash
cd /path/to/repository
wco
```

Type one goal. Repository registration, Web connection and durable history are reused safely.

Use `/` or `/help` to discover commands. Important recovery commands are:

- `/status`: current user-readable stage;
- `/task`: goal and contract state;
- `/review`: exact review/result/PR evidence;
- `/pause`: prevent a new safe transition from starting;
- `/resume`: clear an explicit pause;
- `/doctor`: runtime/auth/sandbox diagnosis;
- `/web status`: relay/GPT/pending-job diagnosis;
- `/history`: bounded repository-specific history.

## Failure and restart behavior

Errors should identify the subsystem, state whether repository/workflow authority changed, and give the next safe action. Expected user errors do not print stack traces. Structured commands retain stable exit codes and JSON when supported.

After terminal loss, process death or a reboot-like fresh shell, run `wco` again in the same repository. WCO reads user-level state, re-attests exact completed evidence and resumes only deterministic work. It does not replay an ambiguous provider call, push or PR creation.

If GitHub or the relay is unavailable, durable local state remains. Restore connectivity and restart `wco`; publication and final review re-check remote identity before continuing. A diverged branch, changed base, stale Web submission or mismatched PR fails closed.

Original uncommitted work is never overwritten. Setup does not modify repository files, and task implementation uses an isolated managed worktree.

## Multiple repositories

Run `wco setup` in another repository. Valid existing user configuration is loaded and the new distinct repository registration is added atomically; existing registrations and user settings are preserved. Repeating setup for the same path/remote is idempotent. A repository-ID collision with a different path/remote fails closed.

History, current task state and managed worktrees remain repository-scoped.

## Web connection operations

Inside the interactive shell:

```text
/web status
/web setup --personal
/web connect
/web open
/web disconnect
/config web
```

`/web setup --personal` is the recommended single-user flow. It generates an owner-only secret, verifies a RelayProtocol-compatible HTTPS mailbox, and materializes the API-key GPT Action files. Provider login and saving the Custom GPT remain one-time human actions. `/web disconnect` removes the selected local credential; managed mode also requests remote device revocation. Tokens must never be put in repository config, task text, logs, result bundles or screenshots.

`/web connect` selects managed OAuth/device onboarding. `/web connect --self-hosted` preserves legacy `actions_relay` configuration. `manual_file` needs neither network path. `web/managed-service.json` is managed-only metadata and does not gate either other profile.

## Doctor

Run `/doctor` interactively or `wco doctor` from the repository. It probes only the selected profile and orchestration mode. Personal checks the Bearer relay but not OAuth/device/account. Managed checks those managed capabilities. Manual stays offline. PAIR does not require Codex or Sol/Terra; AUTOPILOT checks only its frozen adaptive reviewer runtime. Every mutation path still requires the network-disabled deterministic sandbox.

A failed sandbox check is fatal for model-backed work. There is no unrestricted fallback.

## Uninstall

Interactive:

```text
/uninstall
```

Automation preview and confirmation:

```bash
wco uninstall --purge
wco uninstall --purge --yes
```

WCO inventories canonical owned paths, rejects broad/symlink/overlapping homes, re-attests managed worktrees and refuses dirty/ambiguous cleanup. It never removes source repositories, Git history, remote branches, PRs or deployments. Packed npm installs are removed from the exact detected prefix by a detached post-exit helper.

## Advanced deterministic automation

The commands below expose internal workflow authority. They are for CI, protocol development and backward compatibility—not the daily interactive path.

```bash
wco preview ./task-bundle.zip --state-dir /absolute/state
wco run ./task-bundle.zip --state-dir /absolute/state --config /absolute/config.json
wco status --run-id '<task-id>:<bundle-sha256>' --state-dir /absolute/state
wco continue --run-id '<task-id>:<bundle-sha256>' --state-dir /absolute/state --config /absolute/config.json
```

Task Bundles and Web implementation packs are untrusted until their owning local validators establish authority. Relay history or chat text never substitutes for canonical artifact identities. Read the architecture/protocol/security documents before automating this surface.

## Release-candidate validation

Deterministic gates:

```bash
npm ci
npm run check
npm run pack:check
npm run pack:smoke
npm run test:user:packed
```

Real native gates:

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:native:sandbox
WCO_RUN_CODEX_INTEGRATION=1 npm run test:native:codex
```

The packed candidate—not `dist/` in the checkout—is the final acceptance object. Hosted ChatGPT Web needs a real authenticated HTTPS relay/GPT/browser session; synthetic relay actors cover the same local protocol deterministically but do not replace that hosted smoke.
