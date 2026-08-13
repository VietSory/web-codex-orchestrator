# Operations and user workflow

WCO's normal product path is local-first. Repository state, durable task/session state, context cache, semantic mailbox, MCP server, credentials, Harness and deterministic verification stay on the user's machine.

## Normal interactive workflow

After a human maintainer publishes the package:

```bash
npm install -g web-codex-orchestrator
cd /path/to/project
wco
```

First-run setup detects the canonical Git root, remote/base, project tools, GitHub readiness and verification prerequisites, registers the repository, and selects `web_native_mcp`.

WCO-owned state lives under the platform user-data location (`$XDG_DATA_HOME/wco` or `~/.local/share/wco` on Linux/WSL). Secrets are stored separately in owner-protected local WCO credential storage.

### One-time official OpenAI setup

ChatGPT Web cannot directly reach a localhost MCP server. The normal bridge therefore uses OpenAI Secure MCP Tunnel with `tunnel-client` running locally and outbound-only.

Current OpenAI setup may require provider-owned values such as:

- tunnel ID;
- tunnel runtime API key;
- ChatGPT MCP App/Connector configuration;
- private Workspace Agent trigger/access credential for automatic Web turns.

WCO guides and validates those official OpenAI surfaces once and stores resulting credentials locally. It does not invent a WCO-hosted service or claim a single-click provider provisioning API where none exists.

Normal-path infrastructure budget:

```text
WCO-hosted service              = 0
Cloudflare/ngrok/VPS/domain     = 0
public localhost/inbound port   = 0
third-party WCO relay           = 0
```

After provider setup succeeds once:

```text
per-task browser interactions   = 0
per-task tunnel/key/token input = 0
per-task MCP/App configuration  = 0
```

If the account/workspace lacks the required Secure MCP/full MCP/Workspace Agent capability, WCO fails closed with an OpenAI capability/setup diagnostic. It never tells the normal user to deploy Cloudflare/ngrok/VPS or silently changes transport.

### Start a task

The user types a goal directly in WCO:

```text
> Add rate limiting to POST /login and add regression tests.
```

WCO creates a durable local authoring job and starts the required ChatGPT Web turn automatically through the configured OpenAI path. The user does not open ChatGPT for each task.

Repository inspection is bounded to exact Git objects at the sealed base. Sensitive paths are denied. Web-A seals a testable contract and bounded implementation submission. WCO materializes/validates it locally, applies exact operations in its isolated worktree and runs allowed verification commands in the network-disabled Bubblewrap sandbox.

PAIR then starts independent Web-B review. AUTOPILOT instead uses exactly one frozen Sol/Terra reviewer call by default. Final exact-result evidence starts/resumes the original Web-A final intent review. These task turns require no browser interaction after first setup.

Final APPROVE ends at `READY_FOR_YOU`. REVISE uses bounded Harness-applied same-PR repair and fresh verification. ESCALATE stops for a human decision. Only the human decides merge/release.

## Returning user

```bash
cd /path/to/project
wco
```

Then type a goal. Repository registration, local OpenAI transport credentials and durable task state are reused.

Important commands:

- `/status`: current stage;
- `/task`: goal/contract state;
- `/run`: continue a durable active workflow;
- `/review`: exact verification/review/result/PR evidence;
- `/pause` / `/resume`: safe transition control;
- `/doctor`: selected-mode/transport diagnosis;
- `/web status`: local Web transport state;
- `/web connect`: normal one-time/recovery OpenAI setup;
- `/web disconnect`: remove local OpenAI Web credentials;
- `/history`: bounded repository task history.

`/web open` is a setup/settings helper, not a per-task requirement.

## Failure and restart behavior

Errors identify the subsystem, state whether repository/workflow authority changed and provide the next safe action. Expected user errors do not print raw stack traces.

After terminal loss/process death/restart, run `wco` again. WCO reads durable local state, re-attests completed evidence and restarts/reuses the local tunnel as needed. It does not blindly replay ambiguous provider/model calls.

Workspace Agent triggers are deterministic/idempotency-bound. Suspended/failed/completed-without-required-output runs fail closed. Temporary network failure preserves local state. Diverged branch, changed base, stale Web submission or mismatched PR also fails closed.

Original uncommitted user work is not overwritten; implementation uses an isolated worktree.

## Multiple repositories

Running `wco` in another repository registers it while preserving trusted configuration. Each task remains bound to its exact repository/base identity. Local credentials/runtime may be reused where safe, but repository authority never crosses task bindings.

## Optional Web profiles

Normal:

```text
web_native_mcp
wco web connect
```

Explicit optional compatibility profiles:

```text
wco web connect --managed      # optional hosted/team profile
wco web setup --personal       # optional Custom GPT Action + bearer relay
wco web connect --self-hosted  # optional legacy self-hosted relay
manual_file                    # offline/manual compatibility
```

These profiles are never automatic fallbacks from the local-native path.

## Doctor

`/doctor` probes only the selected profile and orchestration mode.

For `web_native_mcp`, Doctor checks local OpenAI/tunnel credentials and native Web prerequisites while explicitly requiring no third-party relay and no managed device/account service.

PAIR does not probe Codex runtime/auth. AUTOPILOT additionally probes only the selected reviewer runtime/auth prerequisites for its single Sol/Terra pass.

Every mutation path still requires Bubblewrap network-disabled deterministic verification; there is no unrestricted host fallback.

## Uninstall

Interactive:

```text
/uninstall
```

Automation:

```bash
wco uninstall --purge
wco uninstall --purge --yes
```

WCO removes only WCO-owned local resources after safety checks. It never removes source repositories, Git history, remote branches, PRs or deployments.

## Advanced deterministic automation

Internal Task Bundle/run IDs remain available for CI/protocol development, not normal use:

```bash
wco preview ./task-bundle.zip --state-dir /absolute/state
wco run ./task-bundle.zip --state-dir /absolute/state --config /absolute/config.json
wco status --run-id '<task-id>:<bundle-sha256>' --state-dir /absolute/state
wco continue --run-id '<task-id>:<bundle-sha256>' --state-dir /absolute/state --config /absolute/config.json
```

Transport/chat text never substitutes for canonical artifact identities.

## Release-candidate validation

Deterministic gates:

```bash
npm ci
npm run check
npm run pack:check
npm run pack:smoke
npm run test:user:packed
node scripts/run-packed-managed-user-journey.mjs
```

The packed script name is retained temporarily for compatibility; its assertions qualify the local-native normal path.

Environment-backed gates where available:

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:native:sandbox
WCO_RUN_CODEX_INTEGRATION=1 npm run test:native:codex
```

Release acceptance must prove:

```text
default Web profile                  = web_native_mcp
WCO-hosted normal-path services      = 0
third-party relay/cloud setup        = 0
per-task browser interactions        = 0
PAIR model reviewer calls            = 0
AUTOPILOT adaptive reviewer calls    = exactly 1 by default
second Sol/Terra calls               = 0
Harness model tokens                 = 0
same Draft PR / exact digest binding = preserved
human-only merge/release             = preserved
```

A missing OpenAI account/workspace capability is reported as a provider capability blocker, not converted into a WCO server deployment requirement.