# Operations and user workflow

This guide separates WCO's normal product path from advanced compatibility/operator surfaces. A normal user does not maintain protocol IDs, provider credentials, relay infrastructure or manual artifacts.

## Normal interactive workflow

After a human maintainer publishes the package:

```bash
npm install -g web-codex-orchestrator
cd /path/to/project
wco
```

That is the complete normal CLI entry path.

First-run setup detects the canonical Git root, remote/base, project tools, GitHub readiness and verification prerequisites. It registers the repository and selects the default `managed_actions` Web profile. WCO-owned state lives under the platform user-data location (`$XDG_DATA_HOME/wco` or `~/.local/share/wco` on Linux/WSL); secrets are stored separately in owner-protected WCO credential storage.

### Exactly one Web authorization link

On first use, WCO automatically starts the normal connection flow. It does not ask whether the user wants to configure a transport and it does not ask for any endpoint/credential.

WCO sends a device ID, client nonce and PKCE S256 challenge to the maintainer-operated WCO Web service. The service returns one clean `verification_uri_complete`. WCO opens **exactly that one HTTPS URL**. The user authorizes once; WCO polls the one-time device exchange and stores the scoped access/refresh credential.

Normal first-run input budget:

```text
browser authorization URLs = exactly 1
relay/GPT URL input        = 0
tunnel ID input            = 0
API key input              = 0
Workspace Agent ID/token   = 0
GPT/App/MCP creation       = 0
cloud/hosting setup        = 0
```

Returning credentials refresh silently. Revocation/disconnect may require the same one-link authorization again, but never manual provider provisioning.

If the maintainer-operated service is not deployed or its OAuth/App/Agent/automatic-trigger configuration is incomplete, WCO stops with a service/operator diagnostic. That is a release/operator responsibility. It never tells the end user to deploy Cloudflare, configure Secure MCP Tunnel, paste keys or switch transport.

### Start a task

After authorization, the user types a goal directly in WCO:

```text
> Add rate limiting to POST /login and add regression tests.
```

There is no per-task browser click. WCO creates a durable exact authoring job, and the managed bridge automatically triggers Web-A through the maintainer-operated control plane. The user does not open ChatGPT, approve a tool or start an Agent manually.

Repository inspection is bounded to exact Git objects at the sealed base. Sensitive paths are denied. Web-A seals a testable contract and bounded implementation submission. WCO materializes/validates it locally, applies exact operations in its isolated worktree and runs allowed verification commands in the network-disabled Bubblewrap sandbox.

PAIR then registers exact independent-review evidence; the managed bridge automatically triggers independent Web-B. AUTOPILOT instead uses exactly one frozen Sol/Terra review call by default. Final exact-result evidence automatically resumes original Web-A for final intent review. None of these turns needs user browser interaction.

Final APPROVE ends at `READY_FOR_YOU`. REVISE uses bounded Harness-applied same-PR repair and fresh verification. ESCALATE stops for a human decision. Only the human decides merge/release.

## Returning user

```bash
cd /path/to/project
wco
```

Then type a goal. Repository registration, scoped Web authorization and durable task state are reused. Per-task browser interactions = 0.

Important commands:

- `/status`: current stage;
- `/task`: goal/contract state;
- `/run`: continue a durable active workflow;
- `/review`: exact verification/review/result/PR evidence;
- `/pause` / `/resume`: safe transition control;
- `/doctor`: selected-mode/transport diagnosis;
- `/web status`: managed service/authorization state;
- `/web connect`: normal one-link authorization/reauthorization;
- `/web disconnect`: revoke/remove managed local authorization;
- `/history`: bounded repository history.

`/web open` in normal managed mode does not open a per-task ChatGPT page; it reports that Web turns are automatic.

## Failure and restart behavior

Errors identify the subsystem, state whether repository/workflow authority changed and provide the next safe action. Expected user errors do not print raw stack traces.

After terminal loss/process death/restart, run `wco` again in the repository. WCO reads durable state and re-attests completed evidence. It does not blindly replay ambiguous model/provider calls.

Managed Agent triggers are deterministic/idempotency-bound. If an Agent run is suspended, fails, or completes without the required WCO semantic output, WCO stops as an operator/service defect rather than asking the end user to open ChatGPT or approve/configure something per task.

Temporary network unavailability preserves local state. A diverged branch, changed base, stale Web submission or mismatched PR fails closed. Original uncommitted user work is not overwritten; implementation uses an isolated managed worktree.

## Multiple repositories

Running `wco` in another repository registers that repository while preserving existing trusted configuration. The same scoped managed Web authorization can serve multiple registered repositories, but every task remains bound to its exact repository/base identity.

## Advanced Web profiles

Normal:

```text
/web status
/web connect
/web disconnect
/config web
```

Advanced profiles are opt-in only:

```text
wco web connect --native       # Secure MCP Tunnel/operator setup
wco web setup --personal       # Custom GPT Action + bearer relay
wco web connect --self-hosted  # legacy self-hosted relay
manual_file                    # offline/manual compatibility
```

Advanced profiles may expose developer/operator configuration because the user deliberately selected them. They are not normal installation instructions and WCO never auto-switches into them after managed failure.

`web_native_mcp` remains outbound-only and Harness-first, but it is advanced because its current provider setup exposes tunnel/runtime/App/Agent controls forbidden by the normal UX contract.

## Doctor

`/doctor` probes only the selected profile and orchestration mode.

For normal `managed_actions`, Doctor checks:

- maintainer-operated service metadata/readiness;
- ChatGPT/account authorization backend readiness;
- Senior Architect/App/Agent readiness;
- automatic Agent trigger readiness;
- scoped local device credential/refresh;
- relay connection.

It must not ask the user for provider credentials. PAIR does not probe Codex runtime/auth. AUTOPILOT adds only reviewer-runtime/auth prerequisites for the selected single Sol/Terra pass.

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

Environment-backed gates where available:

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:native:sandbox
WCO_RUN_CODEX_INTEGRATION=1 npm run test:native:codex
```

The release is not normal-user ready until maintainer-operated Web infrastructure is deployed and live acceptance proves:

```text
first-run authorization URLs = exactly 1
manual endpoint/credential inputs = 0
per-task browser interactions = 0
PAIR model reviewer calls = 0
AUTOPILOT adaptive reviewer calls = exactly 1 by default
second Sol/Terra calls = 0
Harness model tokens = 0
same Draft PR / exact digest binding = preserved
human-only merge/release = preserved
```

If the hosted service is not deployed, report an operator/release blocker. Never move that setup work onto the end user.