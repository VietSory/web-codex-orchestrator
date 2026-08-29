# Operations and user workflow

WCO is single-user and local-first. Repository state, durable task/session state, exact-read receipts, Harness state, deterministic verification, Git and Draft-PR authority stay on the user's machine.

The normal PAIR provider is ChatGPT Web through WCO's first-party Windows browser companion. Codex remains an explicit provider choice and an AUTOPILOT reviewer dependency; it is not a fallback for PAIR.

## Normal PAIR host boundary

The current first-party PAIR transport is designed for WSL on Windows:

```text
WCO / WSL
  -> bounded JSONL
  -> WCO-owned Windows companion
  -> loopback-only Chrome/Edge CDP
  -> ChatGPT Temporary Chat
```

WSL remains the deterministic execution host because verification uses Bubblewrap. Native Windows owns only the bounded browser companion process. The companion has no repository, worktree, shell, Git, verifier or publication authority.

Native Linux can execute WCO's Linux verification path, but the current first-party browser companion requires a Windows host reachable through normal WSL interop. A native-Linux user may explicitly select the Codex provider instead.

## Normal interactive workflow

After a human maintainer publishes a qualified release:

```bash
npm install -g ./web-codex-orchestrator-<version>.tgz
cd /path/to/project
wco
```

Fresh setup defaults the owner-local provider preference to `chatgpt-web`. Trusted repository config intentionally contains no `web_bridge` field for the normal path.

### First browser sign-in

PAIR does not delegate sign-in to Codex. WCO bootstraps the first-party Windows companion, verifies its checksum and uses a WCO-owned browser profile.

If the profile is not signed in to ChatGPT, finish sign-in in the WCO Chrome/Edge window. WCO never copies cookies/tokens or reuses the user's ordinary browser profile.

Manual setup budget:

```text
ChatGPT sign-in in WCO browser profile = once when required
Cloudflare/ngrok/VPS/domain/DNS         = 0
relay/GPT URL inputs                    = 0
tunnel IDs                              = 0
API/bearer keys                         = 0
MCP App setup                           = 0
Workspace Agent/trigger setup           = 0
copied browser credentials              = 0
Codex provider authentication for PAIR  = 0
```

After readiness:

```text
per-task manual browser interactions = 0
per-task credential inputs           = 0
per-task infrastructure setup        = 0
Codex provider/model turns in PAIR    = 0
```

The companion still automates browser turns. Each semantic/review turn uses a fresh ChatGPT Temporary Chat.

### Readiness

Use:

```bash
wco web status
wco doctor --mode PAIR
```

PAIR readiness requires the first-party companion/browser session, provider-independent verification isolation, Git and GitHub publication prerequisites. It does **not** require Codex auth/runtime.

If browser/helper readiness fails, WCO fails closed. It never silently falls back to Codex, a legacy helper, relay or advanced profile.

### Start a task

The user types a goal:

```text
> Add rate limiting to POST /login and add regression tests.
```

or explicitly:

```text
/new Add rate limiting to POST /login and add regression tests
```

PAIR path:

```text
ChatGPT Web author
→ bounded exact repository reads
→ sealed contract + bounded implementation authority
→ Harness apply
→ deterministic verification
→ independent ChatGPT Web code review
→ exact Draft PR / Result Bundle
→ original ChatGPT Web final intent review
→ READY_FOR_YOU
```

Provider output is not repository authority by itself. WCO validates closed schemas, exact job/run identities, path policy, preimages/postimages and digests before Harness may mutate anything.

Final APPROVE ends at `READY_FOR_YOU`. REVISE uses bounded Harness-applied repair plus fresh verification. ESCALATE/BLOCK stops for a human decision. Only the human decides merge/release.

## AUTOPILOT

AUTOPILOT is explicit:

```text
/auto <goal>
```

It keeps the ChatGPT Web author/final-review boundary but adds exactly one selected Sol/Terra adaptive review pass on the normal path. That selected reviewer requires the corresponding Codex runtime/auth/quota.

PAIR does not inherit this requirement.

## Returning user

```bash
cd /path/to/project
wco
```

Then type a goal. Normal PAIR should not require relay configuration, manual browser actions per task, or Codex authentication.

Important commands:

- `/status`: current progress and required user action;
- `/task`: current goal and plan state;
- `/continue`: continue only the current unfinished task;
- `/resume`: explicitly select saved history;
- `/review`: verification/review/Draft-PR evidence;
- `/pause`: pause at a safe boundary;
- `/doctor`: readiness for the selected mode;
- `/auth status` / `/auth connect`: provider readiness/sign-in recovery;
- `/history`: read-only task history.

`/run` remains parser-compatible with `/continue`, but normal user guidance teaches `/continue`.

## Provider switching

Default/normal PAIR:

```bash
wco setup --provider chatgpt-web
```

Explicit Codex semantic provider:

```bash
wco setup --provider codex
```

Only the persisted `codex` choice authorizes use of Codex for the semantic provider. Missing preferences are not treated as permission to spend Codex quota.

## Optional compatibility profiles

Explicit `web_bridge` profiles remain advanced only:

```text
web_native_mcp
managed_actions
personal_actions
actions_relay
manual_file
```

None is an automatic fallback from first-party browser PAIR.

## Failure and restart behavior

Durable state is written before authority-bearing side effects. After terminal/process loss, run `wco` again and use `/continue` for the current task. WCO re-attests exact durable identities instead of blindly replaying completed or ambiguous provider turns.

A persistent ChatGPT browser profile is session continuity only. Browser UI state is never repository or shipment authority.

Original uncommitted user work is not overwritten; implementation uses the isolated worktree/Harness path.

## Multiple repositories

Running WCO in another repository registers that repository while preserving trusted owner-local provider preferences. Every task remains bound to its exact repository/base identity.

Provider session reuse never crosses repository authority boundaries.

## Doctor modes

PAIR:

```bash
wco doctor --mode PAIR
```

must not require Codex authentication for the default `chatgpt-web` provider.

AUTOPILOT:

```bash
wco doctor --mode AUTOPILOT
```

adds the selected Sol/Terra reviewer runtime/auth checks.

## Uninstall

```bash
wco uninstall --purge
wco uninstall --purge --yes
```

WCO removes only WCO-owned local resources after safety checks. It never removes source repositories, Git history, remote branches, PRs or releases.

## Release-candidate validation

The first-party PAIR path is not release-qualified until exact-head evidence proves:

```text
first-party Windows companion build       = PASS
companion native JSONL smoke               = PASS
companion SHA-256 sidecar                  = PASS
final companion Authenticode state         = clean unsigned or intentionally signed
PAIR Codex provider turns                  = 0
missing helper/browser fallback to Codex   = 0
per-task manual browser interactions       = 0
repository mutation outside Harness        = 0
automatic merge/release                    = 0
Main deterministic CI                      = PASS
Advanced compatibility CI                  = PASS
real signed-in Windows/WSL PAIR dogfood    = PASS
```

CI proves build/protocol/deterministic behavior but cannot prove an actual signed-in ChatGPT browser session. Real Windows/WSL acceptance remains a required local gate.
