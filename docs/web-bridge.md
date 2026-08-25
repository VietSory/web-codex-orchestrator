# ChatGPT Web bridge

WCO keeps repository state, exact-read evidence, mutation authority, deterministic verification, Git and Draft-PR publication authority on the user's machine.

## Default provider

Fresh setup defaults the owner-local provider preference to `chatgpt-web`. Trusted repository config intentionally has no `web_bridge` field; absence means “use the normal local provider selection”, not “use Codex”.

Only an explicit persisted `provider: "codex"` selects the Codex semantic transport. Missing provider preferences are treated as upgrade/recovery state and default to ChatGPT Web so WCO never spends Codex quota by accident.

For PAIR, the normal transport is:

```text
WCO / WSL
  -> bounded JSONL stdin/stdout
  -> WCO-owned Windows browser companion
  -> loopback-only Windows Chrome/Edge CDP
  -> real ChatGPT Temporary Chat
```

There is no normal-path WCO server, relay, database, hosted control plane, Custom GPT, MCP connector or public workstation endpoint.

## Windows companion boundary

The first-party companion is a separate native Windows executable. It accepts only the versioned WCO browser-companion protocol:

- prepared prompt text;
- bounded model mode metadata;
- inspect/run/abort/shutdown identities.

Repository paths, worktree paths, Task/Result Bundle authority, Git commands, tool commands, cookies, tokens and arbitrary CDP parameters are not protocol fields.

The companion owns its Chrome/Edge process, WCO-owned persistent browser profile and loopback-only CDP endpoint. WSL never opens a CDP connection to Windows.

## Sign-in and browser state

WCO does not copy ChatGPT cookies, tokens or the user's existing browser profile.

When the companion first needs ChatGPT, the user signs in inside the WCO-owned Chrome/Edge profile. That profile may persist the provider session so normal returning use does not require manual sign-in for every task.

Each semantic/review turn uses a fresh ChatGPT Temporary Chat and proves the expected ChatGPT origin/temporary-chat state before model work proceeds.

For healthy PAIR:

```text
Codex provider authentication         = not required
Codex provider/model turns            = 0
per-task manual browser interactions  = 0
copied browser credentials            = 0
```

Browser automation itself is expected: it is the purpose of the first-party companion. The security claim is that automation stays inside the WCO-owned native Windows boundary and receives no repository mutation authority.

## Fail-closed behavior

PAIR never silently falls back from the browser companion to Codex, a legacy browser helper, a relay or another Web profile.

Missing helper/setup/browser/session readiness is a blocker. `wco doctor --mode PAIR` and `wco web status` report browser readiness. CI never launches the user's browser or contacts ChatGPT; real signed-in browser acceptance remains a local qualification gate.

The compatibility `ChatGptCodexWebBridge` remains available only when the owner explicitly selects the `codex` provider. Its presence is not fallback authority for browser PAIR.

## Semantic authority

ChatGPT Web may request bounded repository context and may seal a contract or produce bounded implementation/review authority. It has no direct filesystem mutation, shell, Git, publish, merge or release authority.

WCO parses provider output through closed local schemas and verifies exact repository/job/run/digest bindings before it can affect durable workflow state.

PAIR uses separate Web review purposes:

```text
Web-A  original author / final intent review
Web-B  independent code review
```

Both are bound to exact durable evidence. Repair authority, when allowed, is bounded and Harness-applied.

## Harness implementation

After contract sealing, WCO binds the task to a canonical prepared run. ChatGPT Web supplies bounded implementation operations; Harness validates exact paths, preimages, postimages, digests and job/run bindings before any worktree mutation.

Deterministic verification, repair application, Git and Draft-PR delivery remain WCO/Harness authority.

A durable reservation is written before authority-bearing provider turns. If a crash leaves an ambiguous unsealed turn, WCO refuses blind replay rather than risk conflicting implementation/review authority.

## Context efficiency

Context remains progressive:

```text
goal
  -> summary / bounded tree / search
  -> focused exact file or byte-region reads
  -> digest reuse
  -> sealed contract
  -> implementation/result deltas
```

Advisory summaries or indexes may improve localization, but authoritative bytes resolve back to exact Git/file reads and SHA receipts before mutation.

## Provider selection

Normal PAIR:

```bash
wco setup --provider chatgpt-web
```

Explicit Codex alternative:

```bash
wco setup --provider codex
```

AUTOPILOT may additionally require the selected Sol/Terra reviewer runtime/authentication; that does not change PAIR's zero-Codex provider-turn contract.

## Advanced compatibility profiles

Explicit `web_bridge` profiles may remain for existing/advanced users:

```text
web_native_mcp
managed_actions
personal_actions
actions_relay
manual_file
```

They are never the fresh default and never a silent fallback from first-party browser PAIR.

## Recovery commands

```bash
wco web status
wco web connect
wco doctor --mode PAIR
```

For `chatgpt-web`, `wco web connect` checks/retries companion readiness; it does not authorize a Codex fallback. For an explicitly selected `codex` provider, Codex's official ChatGPT login lifecycle remains separate.
