# Operations and user workflow

WCO is single-user and local-first. Repository state, durable task/session state, exact-read receipts, context cache, Harness state and deterministic verification stay on the user's machine.

ADR 0004 defines the target normal-user transport. It becomes the shipped default only after its exact-head release gates pass; until then this Draft PR must not claim production readiness.

## Normal interactive workflow

After a human maintainer publishes a qualified release:

```bash
npm install -g web-codex-orchestrator
cd /path/to/project
wco
```

### First use only

**Exactly one Web authorization link** is allowed in the normal path: WCO opens the official ChatGPT browser authorization owned by the bundled Codex runtime. The runtime owns its account credential lifecycle. WCO does not ask the user to copy provider credentials or browser state.

Normal-user manual setup budget:

```text
ChatGPT browser authorization        = exactly 1 on first use
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

WCO creates durable semantic state locally. The `chatgpt_codex` transport supplies bounded architect/research/review decisions through the official runtime. WCO's existing exact repository-read protocol supplies only the context requested by the semantic workflow: summary, bounded tree/search, exact full-file or byte-region reads and digest references.

Provider output is not repository authority by itself. The provider envelope is closed and its nested repository-command, contract, implementation or verdict payload is parsed again through WCO's existing strict validators.

Harness remains the only worktree mutation, command, deterministic verification and Git authority. Sensitive-path, traversal/symlink, preimage/postimage, stale-digest and sandbox checks remain unchanged.

PAIR uses an independent semantic review identity. AUTOPILOT keeps its existing bounded reviewer policy. Final intent review remains bound to the original author intent/thread or an exact durable reconstruction after crash recovery.

Final APPROVE ends at `READY_FOR_YOU`. REVISE uses bounded Harness-applied same-PR repair plus fresh verification. ESCALATE stops for a human decision. Only the human decides merge/release.

## Returning user

```bash
cd /path/to/project
wco
```

Then type a goal. No normal returning-user configuration step is allowed. If authorization has been revoked and cannot be silently refreshed by the official runtime, WCO may request the same ChatGPT browser authorization again; it must not request another kind of setup.

Important commands remain:

- `/status`: current stage;
- `/task`: goal/contract state;
- `/run`: continue a durable active workflow;
- `/review`: exact verification/review/result/PR evidence;
- `/pause` / `/resume`: safe transition control;
- `/doctor`: selected-mode/transport diagnosis;
- `/web status`: local semantic transport state;
- `/history`: bounded repository task history.

## Failure and restart behavior

After terminal loss/process death/restart, run `wco` again. WCO reads durable local state and resumes from completed checkpoints instead of blindly replaying model turns.

Persisted semantic thread identities are conversation bindings only. They never create filesystem, command, Git, verifier, publication or merge authority.

The official app-server/runtime may be used for persisted thread resume, independent forks, context compaction and detached review. WCO must still bind lifecycle events to exact response/thread/turn identities, enforce timeouts and fail closed on inconsistent provider lifecycle data.

Original uncommitted user work is not overwritten; implementation uses the existing isolated worktree/Harness path.

## Multiple repositories

Running `wco` in another repository registers it while preserving trusted configuration. Each task remains bound to its exact repository/base identity. Runtime account authorization may be reused locally where safe, but repository authority never crosses task bindings.

## Optional Web profiles

Target normal profile after ADR 0004 release gates pass:

```text
chatgpt_codex
```

Advanced `web_native_mcp` remains explicit and is not part of normal setup.

Other explicit compatibility/operator profiles remain available only when deliberately selected:

```text
web_native_mcp
managed_actions
personal_actions
actions_relay
manual_file
```

None is an automatic fallback from `chatgpt_codex`.

## Doctor

For `chatgpt_codex`, Doctor must check only the bundled runtime, ChatGPT account authorization, local semantic state and ordinary WCO/Harness prerequisites. It must not ask for a relay, tunnel, API key, MCP App, Workspace Agent, hosted service or browser cookie.

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

ADR 0004 cannot become the shipped default until exact-head evidence proves:

```text
first-run browser authorization surfaces = exactly 1
manual credential/ID/endpoint inputs      = 0
Cloudflare/VPS/domain/DNS requirements    = 0
tunnel/MCP/App/Agent setup requirements   = 0
per-task browser interactions             = 0
browser DOM/output scraping               = 0
repository mutation outside Harness       = 0
force push / auto merge / release         = 0
crash/restart requires reconfiguration    = 0
PAIR and AUTOPILOT safety suites          = PASS
packed-user journey                       = PASS
```

Deterministic gates remain:

```bash
npm ci
npm run check
npm run pack:check
npm run pack:smoke
npm run test:user:packed
```

Environment-backed integration gates remain additional evidence where available. A missing provider/runtime capability is reported as a capability blocker; it is never converted into a requirement for the user to deploy infrastructure.