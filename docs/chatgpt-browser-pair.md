# ChatGPT Web browser PAIR

This core transport is a direct, personal ChatGPT Web path for PAIR. It exists so a PAIR run can use the user's normal ChatGPT Web entitlement instead of spending Codex provider/model quota.

For WSL on Windows, the preferred qualified boundary is now the Windows-native launcher helper shipped by `miuuyy/codex-chatgpt-web` 3.0.3. WCO stays in WSL/Linux for bundle validation, repository mutation, Bubblewrap verification, Git and publication authority. Browser turns cross only bounded stdin/stdout into the launcher helper; WCO does not connect from WSL to the launcher's CDP/control endpoints.

The legacy direct Chromium/CDP adapter remains available only when the qualified launcher helper is not installed/discoverable, mainly for non-WSL compatibility and local qualification.

Neither path reads ChatGPT cookies/tokens, calls private ChatGPT HTTP endpoints, bypasses CAPTCHA/protective measures, or depends on Codex model turns.

## Daily setup

For a fresh WCO installation, normal first-run setup saves `chatgpt-web` as the PAIR provider. Explicit selection is:

```bash
wco setup --yes --provider chatgpt-web
```

To switch back deliberately:

```bash
wco setup --provider codex
```

There is no Codex-quota probe and no Codex fallback router inside browser PAIR. Browser provider turns are selected before the PAIR session starts.

## WSL + Windows launcher helper

The qualified helper path expects `miuuyy/codex-chatgpt-web` release 3.0.3 (qualified provenance commit `2569603f950de3a123e31bd26e7c8757566066f3`) installed as the Windows launcher. The launcher owns the signed-in embedded browser and publishes an owner-local browser-host descriptor containing its helper executable and helper script.

WCO discovers the normal Windows config at `%USERPROFILE%\\.codex-chatgpt-web\\config.json` through WSL interop. A custom install can be selected explicitly with:

```bash
export WCO_CHATGPT_WEB_MIUUYY_CONFIG='C:\\path\\to\\.codex-chatgpt-web\\config.json'
```

WCO validates `releaseVersion=3.0.3`, launcher descriptor identity/version/profile, helper paths, saved account capabilities, and then runs the launcher's own helper protocol over stdin/stdout. `inspect` must prove an authenticated Temporary Chat and live account capabilities before readiness succeeds.

When the helper executable is Win32 and WCO is running in WSL, WCO adds the Electron helper-mode variables to `WSLENV` with `/w` so they are explicitly forwarded WSL→Windows. No `.wslconfig`, mirrored networking, firewall rule or port proxy is required for this transport.

Optional model selection:

```bash
export WCO_CHATGPT_WEB_COMPANION_MODE=high
```

Allowed values: `instant`, `medium`, `high`, `extra-high`, `pro`, `luna`. Unavailable account modes fail closed.

## Intended flow

```text
goal
  -> ChatGPT Web author / repository reasoning
  -> ChatGPT Web implementation proposal
  -> WCO Harness applies bounded operations
  -> deterministic tests / verification
  -> fresh independent ChatGPT Web reviewer
       -> APPROVE
       -> or one bounded REVISE repair + re-verification
       -> or ESCALATE and stop safely
  -> push reviewed exact head
  -> open Draft PR
  -> human decides merge/release
```

The main implementation logical thread and reviewer logical thread are separate. Because every launcher browser turn is a fresh Temporary Chat, WCO replays only bounded prior WCO prompt/JSON continuity when a semantic phase requires continuation. Unknown or oversized logical history fails closed rather than inventing continuity.

## Context and authority

Implementation and pre-publish review receive a bounded inline context pack containing accepted Task Bundle text plus repository text admitted by `manifest.json.allowed_paths`, excluding forbidden paths and obvious credential material. Context export is bounded and fails closed instead of silently truncating required files.

The launcher helper remains a read-only model boundary for WCO: local tools are disabled, `autoApproveToolCalls` is false, and WCO is the only repository mutation/Git/publish authority.

The Draft PR stays downstream of all local gates:

```text
Harness apply -> deterministic verification -> independent ChatGPT Web review -> Draft PR
```

Merge and release remain human-only.

## Usage accounting

ChatGPT Web does not expose reliable per-turn token telemetry to WCO. Browser turns therefore use zero token counters as an unavailable-telemetry sentinel, not as a claim that the ChatGPT model consumed zero tokens.

Browser PAIR makes no Codex provider/model turn when `chatgpt-web` is selected. ChatGPT Web account usage/limits still apply normally.

## Qualification

Automated tests can prove WCO's protocol, selection, fail-closed rules, context binding, reviewer routing and package behavior. They cannot prove the user's signed-in ChatGPT browser session. Real browser qualification therefore requires local dogfood through the running launcher; see `docs/miuuyy-helper-pair-dogfood.md`.
