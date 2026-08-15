# Operations and user workflow

WCO is single-user and local-first. Repository state, durable task/session state, exact-read receipts, context cache, Harness state and deterministic verification stay on the user's machine.

ADR 0004 defines the normal-user transport implemented on this branch. A fresh config intentionally has no `web_bridge` field; absence selects the local ChatGPT/Codex transport. Release readiness remains gated on exact-head deterministic CI plus a real local one-authorization acceptance.

## Normal interactive workflow

After a human maintainer publishes a qualified GitHub Release, download the packaged `.tgz` artifact and install that exact release once:

```bash
npm install -g ./web-codex-orchestrator-<version>.tgz
cd /path/to/project
wco
```

Normal users do not clone/build WCO and should not use GitHub's automatic source-code archives as the CLI package.

### First use only

The normal path permits one provider-owned ChatGPT authorization interaction. WCO delegates it to the bundled pinned official Codex runtime and does not read, copy or persist the provider token itself. Interactive first use requests the official authorization automatically when needed; `wco web connect` remains an explicit reauthorization command.

Normal-user manual setup budget:

```text
ChatGPT browser authorization        = 1 on first use when required
Cloudflare/ngrok/VPS/domain/DNS      = 0
relay/GPT URL inputs                 = 0
tunnel IDs                           = 0
API/bearer keys                      = 0
MCP App setup                        = 0
Workspace Agent/trigger setup        = 0
OAuth client setup                   = 0
browser cookie/profile import        = 0
public workstation endpoint          = 0
```

After authorization:

```text
per-task browser interactions = 0
per-task credential inputs    = 0
per-task infrastructure setup = 0
```

If the bundled official runtime cannot use the authorized ChatGPT account, WCO fails closed. It must not silently fall back to hosting, relay, tunnel, browser scraping or manual credentials.

### Start a task

The user types only a goal:

```text
> Add rate limiting to POST /login and add regression tests.
```

WCO creates durable semantic state locally. The local ChatGPT/Codex transport supplies bounded architecture, repository-analysis and review decisions through the official runtime. WCO's existing repository-read protocol supplies only requested exact context: summary, bounded tree/search, full-file or byte-region reads and digest references.

The current release candidate deliberately keeps semantic and implementation-planning Codex turns read-only, no-approval, no-network and with provider Web search disabled. External live-Web research is therefore not a release capability of this transport. If added later, it must be a separately reviewed semantic-only capability and must not widen Harness or repository authority.

Provider output is not repository authority by itself. Semantic author output is restricted to repository-context requests or a sealed contract. The Harness-side implementation planner produces a separately structured implementation proposal after the canonical run is prepared. Repository-command, contract, implementation and verdict payloads are parsed again through WCO's strict validators and exact identity/digest bindings before workflow authority can advance.

Harness remains the only worktree mutation, command, deterministic verification and Git authority. Sensitive-path, traversal/symlink, preimage/postimage, stale-digest and sandbox checks remain unchanged.

PAIR uses independent review state where required by its policy. AUTOPILOT keeps its bounded reviewer/repair policy. Final intent review remains bound to exact durable intent/run/result evidence. Semantic thread IDs are continuity metadata, not mutation authority.

Final APPROVE ends at `READY_FOR_YOU`. REVISE uses bounded Harness-applied same-PR repair plus fresh verification. ESCALATE stops for a human decision. Only the human decides merge/release.

## Returning user

```bash
cd /path/to/project
wco
```

Then type a goal. No normal returning-user configuration step is allowed. If authorization has been revoked and cannot be silently refreshed by the official runtime, WCO requests the same provider-owned ChatGPT authorization again; it must not request another kind of setup.

Important commands remain:

- `/status`: current progress and next task state;
- `/task`: current goal and plan state;
- `/run`: continue a durable active workflow;
- `/review`: verification, review and Draft-PR evidence;
- `/pause` / `/resume`: safe transition control;
- `/doctor`: selected-mode/transport diagnosis;
- `/web status`: local semantic transport and authorization state;
- `/history`: bounded repository task history.

`wco web status` distinguishes a healthy local runtime from a missing/expired ChatGPT authorization. `wco web connect` is the normal explicit reauthorization command. It never changes the transport profile.

## Failure and restart behavior

After terminal loss/process death/restart, run `wco` again. WCO reads durable local state and resumes from completed checkpoints instead of blindly replaying completed authority-bearing model turns.

Persisted semantic thread identities are conversation bindings only. They never create filesystem, command, Git, verifier, publication or merge authority.

The current implementation uses the bundled official Codex CLI/SDK for login and resumable threads. A future app-server adapter may reuse equivalent official login/thread/fork/compact/review primitives without changing `WebBridge` authority semantics, but app-server-specific behavior is not required for this release candidate.

Original uncommitted user work is not overwritten; implementation uses the existing isolated worktree/Harness path.

## Multiple repositories

Running `wco` in another repository registers it while preserving trusted configuration. Each task remains bound to its exact repository/base identity. Runtime account authorization may be reused locally where safe, but repository authority never crosses task bindings.

## Optional Web profiles

Normal zero-config selection:

```text
web_bridge absent -> local ChatGPT/Codex
```

The internal transport identity is `chatgpt_codex`; no normal-user transport credential or endpoint is written to trusted config.

Explicit compatibility/operator profiles remain available only when deliberately selected:

```text
web_native_mcp
managed_actions
personal_actions
actions_relay
manual_file
```

None is an automatic fallback from the local transport.

## Doctor

For the zero-config local transport, Doctor checks only the bundled runtime, ChatGPT account authorization/readiness, local semantic state and ordinary WCO/Harness prerequisites. It must not ask for a relay, tunnel, API key, MCP App, Workspace Agent, hosted service or browser cookie.

Every mutation path still requires the existing deterministic verifier boundary; there is no unrestricted host fallback.

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

The normal local transport is not release-qualified until exact-head evidence proves:

```text
normal-user authorization interaction    = one provider-owned ChatGPT flow
manual credential/ID/endpoint inputs      = 0
Cloudflare/VPS/domain/DNS requirements    = 0
tunnel/MCP/App/Agent setup requirements   = 0
per-task browser interactions             = 0
browser DOM/output scraping               = 0
repository mutation outside Harness       = 0
force push / auto merge / release         = 0
crash/restart requires reconfiguration    = 0
PAIR and AUTOPILOT deterministic suites   = PASS
clean packed install                       = PASS
zero-config daily-user contract            = PASS
```

Deterministic gates:

```bash
npm ci
npm run check
npm run pack:check
npm run pack:smoke
npm run test:user:contract
```

GitHub CI also runs the clean packed-install and zero-config contract as explicit steps. A real local acceptance remains required because CI cannot prove an actual user's browser authorization/account session. A missing provider/runtime capability is reported as a capability blocker; it is never converted into a requirement for the user to deploy infrastructure.
