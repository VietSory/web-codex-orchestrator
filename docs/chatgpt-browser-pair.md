# ChatGPT Web browser PAIR

This core transport is a direct, personal ChatGPT Web path for PAIR. It exists so a PAIR run can use the user's normal ChatGPT Web session instead of spending Codex provider/model quota.

It drives the user's own local Chromium browser session through the Chrome DevTools Protocol. It does **not** read ChatGPT cookies/tokens, call private ChatGPT HTTP endpoints, bypass CAPTCHA/protective measures, or depend on Codex model turns.

## Daily setup

For a fresh installation, normal first-run setup now saves `chatgpt-web` as the PAIR provider. In practice the normal flow is simply:

```bash
cd /path/to/project
wco
```

WCO registers the repository, stores the owner-local provider preference, opens its dedicated ChatGPT browser profile when sign-in is needed, and then future terminals only need `wco` plus a goal.

To select the provider explicitly:

```bash
wco setup --provider chatgpt-web
```

To switch back to the bundled Codex provider later:

```bash
wco setup --provider codex
```

The saved choice lives in WCO-owned local preferences next to the state directory. It is deliberately separate from trusted repository configuration because provider choice is user/product UX state, not repository authority.

`WCO_CHATGPT_BROWSER=1` remains supported only as a development/qualification override. Normal users do not need to export it.

There is no Codex-quota probe and no Codex-to-browser fallback router in direct browser PAIR. The browser transport owns provider turns from the beginning of the PAIR session.

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

The independent reviewer is deliberately **before publication**. Browser PAIR therefore has one quality-review gate after implementation and verification, then creates the Draft PR only after that gate is satisfied. It does not require a second post-PR model review.

The main implementation conversation and the reviewer conversation are separate ChatGPT Web threads. The reviewer is not given the author's hidden conversation state; it receives the exact bounded Task Bundle and repository context needed to challenge the resulting change independently.

## First browser login

On the first browser run WCO opens a dedicated Chrome/Edge profile at `chatgpt.com`. Sign in once in that profile. Subsequent runs reuse the profile and can create/resume conversations automatically.

If WCO cannot discover Chromium, set an absolute executable path:

```bash
export WCO_CHATGPT_BROWSER_EXECUTABLE="/usr/bin/google-chrome"
```

On WSL, WCO also probes common Windows Chrome and Edge locations under `/mnt/c` and converts local paths with `wslpath` when necessary.

Optional bounds:

- `WCO_CHATGPT_BROWSER_PROFILE` — absolute dedicated browser profile directory.
- `WCO_CHATGPT_BROWSER_LOGIN_SECONDS` — login/composer readiness deadline, default `120`, maximum `900`.
- `WCO_CHATGPT_BROWSER_RESPONSE_SECONDS` — one Web response deadline, default `900`, maximum `3600`.
- `WCO_CHATGPT_BROWSER_CONTEXT_BYTES` — context-pack ceiling, default `6291456`, maximum `12582912`.

## Readiness behavior

`wco doctor` reads the same saved provider preference. For PAIR with `chatgpt-web` selected:

- Codex runtime is not a readiness requirement;
- Codex authentication is not a readiness requirement;
- ChatGPT Web browser-profile readiness is checked directly;
- Git/GitHub and deterministic verification requirements remain unchanged.

AUTOPILOT keeps its own reviewer/runtime requirements and is not silently reinterpreted as browser PAIR.

## Context and authority

A new browser provider thread creates a new ChatGPT conversation. WCO stores the resulting `https://chatgpt.com/c/...` URL as the provider `thread_id`; a continuation turn reopens exactly that URL.

Semantic authoring continues to use WCO's bounded repository-command protocol. Implementation and the independent pre-publish reviewer receive a temporary bounded context attachment containing:

1. accepted Task Bundle text files;
2. repository text files admitted by `manifest.json.allowed_paths`;
3. no file matched by `forbidden_paths`;
4. no obvious credential material such as `.env*`, `.npmrc`, private keys, or certificate/key containers.

The context export is bounded by file count, per-file size, and total bytes. It fails closed rather than silently truncating required implementation/review context.

After ChatGPT returns structured output, WCO parses and revalidates it through the existing schemas. The reviewer never mutates the worktree directly. A REVISE verdict may contain exactly one bounded repair proposal; the Harness validates, applies, and re-runs deterministic verification before publication.

The Draft PR is therefore downstream of all three local gates:

```text
Harness apply -> deterministic verification -> independent ChatGPT Web review -> Draft PR
```

Merge and release remain human-only.

## Protective behavior

The browser adapter intentionally fails if it detects a human-verification/protective page. There is no CAPTCHA solver, anti-bot bypass, rate-limit bypass, cookie extraction, or private endpoint fallback.

The adapter also refuses continuation URLs outside `https://chatgpt.com/`.

Provider preferences themselves fail closed if malformed or replaced with an unsafe/symlinked file. WCO does not silently fall back to Codex and accidentally spend provider quota when the saved browser preference cannot be trusted.

## Usage accounting

ChatGPT Web does not expose per-turn token telemetry to this adapter. Browser turns therefore use zero token counters as an **unavailable telemetry sentinel**, not as a claim that the model consumed zero tokens. WCO still bounds the number of reviewer turns; browser PAIR permits exactly one independent pre-publish reviewer turn.

This mode is quota-independent from Codex provider turns, but it is still subject to whatever availability/usage rules ChatGPT Web applies to the user's own account.

## Stability warning

This transport depends on the current ChatGPT Web DOM (`#prompt-textarea`, send/stop controls, assistant message attributes and attachment input). A ChatGPT UI change can break it. DOM mismatch is treated as a transport failure; WCO must not fall back to undocumented ChatGPT APIs.
