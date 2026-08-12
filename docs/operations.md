# Operations and user workflow

This guide separates WCO's normal interactive product from advanced compatibility and deterministic automation surfaces. A normal user should not maintain WCO protocol IDs, move artifacts manually, or provision third-party infrastructure.

## Normal interactive workflow

After a human release publishes the package to npm:

```bash
npm install -g web-codex-orchestrator
cd /path/to/project
wco
```

That is the complete normal CLI entry path.

First-run setup detects the canonical Git root, deterministic remote (`origin` when present), current/base branch, project tools, GitHub readiness, verification prerequisites and the default `web_native_mcp` profile. It writes only WCO-owned data under the platform user-data location:

- Linux/WSL: `$XDG_DATA_HOME/wco` or `~/.local/share/wco`;
- macOS: `~/Library/Application Support/wco`;
- Windows: `%LOCALAPPDATA%\WCO`.

`WCO_HOME` may override this for isolated testing or advanced operation. Normal users do not set `WCO_CONFIG`, `WCO_STATE_DIR` or `WCO_RUN_ID`.

### One-time Web-native authorization

On first run, WCO offers to run:

```text
/web connect
```

This setup opens only official OpenAI/ChatGPT pages needed for:

1. an OpenAI Secure MCP Tunnel identity;
2. its official runtime API credential;
3. a private WCO MCP app in ChatGPT using that tunnel;
4. a private WCO Workspace Agent using the shipped Senior Architect instructions and WCO MCP app;
5. a Workspace Agent trigger identity/access token.

WCO stores resulting secrets only in owner-protected WCO credential storage and verifies that its pinned, checksum-verified official `openai/tunnel-client` can connect to the local WCO MCP server. The user does not run or configure `tunnel-client` manually during daily use.

The default path does **not** ask the user to configure Cloudflare, ngrok, a VPS, custom domain, DNS, AWS, public localhost exposure, an external OAuth service or a relay secret.

The WCO MCP app exposes exact read tools plus three non-destructive semantic submit tools: contract, implementation authority and review verdict. These submit tools write only bounded semantic envelopes into WCO durable local state. They cannot edit repository files, execute shell/Git, verify, publish, merge, deploy or release. Harness remains the sole mutation authority.

For zero-click daily runs, the one-time private Agent/App configuration may set those three semantic submit tools to `Never ask` (or the equivalent no-per-run-confirmation option) **only when the OpenAI workspace policy explicitly permits it**. WCO never mislabels the tools read-only to bypass ChatGPT policy.

If the required official Secure MCP Tunnel/full-MCP/Workspace-Agent capabilities are unavailable for the user's OpenAI plan/workspace, setup fails closed with `OPENAI_CAPABILITY_BLOCKED` or a more specific Web-native diagnostic. WCO does not automatically enable Cloudflare, browser automation, public hosting or undocumented ChatGPT interfaces.

### Start a task

After one-time authorization, the user enters a goal directly in WCO. No browser click or manual transport step is required for each task:

```text
> Add rate limiting to POST /login and add regression tests.
```

WCO creates the durable authoring job, ensures the outbound Secure MCP Tunnel is alive, and triggers the private Workspace Agent with a deterministic idempotency key. Original Web-A author/final-review work reuses the same conversation key; independent PAIR Web-B review uses a distinct conversation identity.

Repository inspection is bounded to exact Git objects at the sealed base. `.git/**`, `.env` and other sensitive paths are denied. Search/read receipts become part of local authority validation. WCO progressively retrieves only relevant context and may use content digests to avoid retransmitting unchanged immutable bytes.

The Web actor seals a testable contract and bounded implementation submission. WCO materializes them locally into canonical internal artifacts, validates them, prepares an isolated worktree, applies exact preimages, and runs allowed verification commands in the network-disabled Bubblewrap sandbox.

PAIR uses independent Web-B review and no model reviewer. AUTOPILOT uses exactly one frozen Sol/Terra review call by default, including any bounded repair in that same response. A later original-Web final REVISE never causes a second Sol/Terra call.

Only the exact verified/reviewed result may be committed and normally pushed to the configured delivery branch. WCO creates or reuses one Draft PR. It does not force-push, push to a protected base, mark ready, merge, delete remote branches, deploy or release.

Final original-Web review is bound to the exact Result Bundle and published commit/PR head. APPROVE ends at the human merge boundary. REVISE performs bounded same-PR repair with fresh deterministic verification and a new immutable result generation. ESCALATE stops for a human.

## Returning user

```bash
cd /path/to/project
wco
```

Type one goal. Repository registration, OpenAI Web-native authorization and durable WCO history are reused safely. WCO owns local tunnel start/stop/reconnect; the user does not reconfigure OpenAI for every task.

Use `/` or `/help` to discover commands. Important commands:

- `/status`: current user-readable stage;
- `/task`: goal and contract state;
- `/run`: continue the active workflow;
- `/review`: exact verification/review/result/PR evidence;
- `/pause`: prevent the next safe transition from starting;
- `/resume`: clear an explicit pause;
- `/doctor`: selected-mode/transport/runtime diagnosis;
- `/web status`: Web-native credential/pending-job diagnosis;
- `/web connect`: one-time official OpenAI/ChatGPT setup or reconnect;
- `/history`: bounded repository-specific history.

## Failure and restart behavior

Errors identify the subsystem, state whether repository/workflow authority changed, and provide the next safe action. Expected user errors do not print raw stack traces.

After terminal loss, process death or a reboot-like fresh shell, run `wco` again in the same repository. WCO reads durable state, re-attests exact completed evidence, restarts its local outbound tunnel when required, and resumes only work whose authority can be proven.

WCO does not blindly replay an ambiguous model/Workspace-Agent/provider call. Workspace Agent triggers carry deterministic idempotency keys. If a provider run becomes `suspended`, fails, or completes without the required WCO semantic output, WCO stops with an explicit fail-closed diagnostic instead of waiting forever or changing transport.

If GitHub or OpenAI connectivity is temporarily unavailable, durable local state remains. Restore connectivity and restart/continue WCO. Publication and final review always re-check exact remote identity before continuing. A diverged branch, changed base, stale Web submission or mismatched PR fails closed.

Original uncommitted user work is never overwritten. Setup does not mutate repository files, and implementation uses an isolated managed worktree.

## Multiple repositories

Run `wco setup` (or simply run WCO's first-run flow) in another repository. Existing valid user configuration is loaded and the distinct repository registration is added atomically; existing registrations and user settings are preserved. Repeating setup for the same path/remote is idempotent. A repository-ID collision with a different path/remote fails closed.

History, current task state and managed worktrees remain repository-scoped. The same owner-level Web-native authorization may serve multiple local repositories while every task is bound to its exact registered repository/base identity.

## Web connection operations

Normal:

```text
/web status
/web connect
/web open
/web disconnect
/config web
```

`/web connect` is the default Web-native setup/reconnect path. `/web open` opens official ChatGPT connector/developer settings; normal daily tasks are triggered by WCO and do not require using `/web open`.

Optional compatibility profiles remain available only when explicitly selected by an advanced user:

- `personal_actions`: Custom GPT Action + Bearer + RelayProtocol endpoint;
- `actions_relay`: legacy self-hosted Bearer profile;
- `managed_actions`: hosted organization OAuth/account/device profile;
- `manual_file`: offline/manual compatibility profile.

`wco web setup --personal` and `wco web connect --managed|--self-hosted` are therefore advanced compatibility commands, not normal installation instructions. `web/managed-service.json` applies only to managed mode and never gates Web-native operation.

WCO never auto-switches to an optional profile after native capability/auth failure.

## Doctor

Run `/doctor` interactively or `wco doctor` from the repository. It probes only the selected profile and orchestration mode.

For `web_native_mcp`, Doctor verifies owner-local native authorization state and reports that no third-party relay or managed device/account is required. PAIR does not probe Codex runtime/auth. AUTOPILOT adds only the pinned reviewer-runtime/auth probes actually required by its single selected Sol/Terra review pass.

Every mutation path still requires the network-disabled deterministic sandbox. A failed sandbox check is fatal; there is no unrestricted host fallback.

## Uninstall

Interactive:

```text
/uninstall
```

Automation preview/confirmation:

```bash
wco uninstall --purge
wco uninstall --purge --yes
```

WCO inventories canonical owned paths, rejects broad/symlink/overlapping homes, re-attests managed worktrees and refuses dirty/ambiguous cleanup. It never removes source repositories, Git history, remote branches, PRs or deployments. A packed npm install is removed from the exact detected npm prefix by the existing detached post-exit helper.

## Advanced deterministic automation

The commands below expose internal workflow authority. They are for CI, protocol development and backward compatibility, not normal daily use:

```bash
wco preview ./task-bundle.zip --state-dir /absolute/state
wco run ./task-bundle.zip --state-dir /absolute/state --config /absolute/config.json
wco status --run-id '<task-id>:<bundle-sha256>' --state-dir /absolute/state
wco continue --run-id '<task-id>:<bundle-sha256>' --state-dir /absolute/state --config /absolute/config.json
```

Task Bundles and Web implementation packs are untrusted until their owning local validators establish authority. Transport history or chat text never substitutes for canonical artifact identities.

## Release-candidate validation

Deterministic gates:

```bash
npm ci
npm run check
npm run pack:check
npm run pack:smoke
npm run test:user:packed
```

Environment-backed native gates where available:

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:native:sandbox
WCO_RUN_CODEX_INTEGRATION=1 npm run test:native:codex
```

The packed package is the final local acceptance object. A human maintainer alone decides merge/release and performs npm publication. No WCO normal flow or CI test may publish the package automatically.

Live Web-native acceptance must use an authorized OpenAI workspace exposing the required official capabilities. If that workspace capability is unavailable, the honest result is `OPENAI_CAPABILITY_BLOCKED`, not a fabricated PASS and not a requirement to provision a third-party relay.