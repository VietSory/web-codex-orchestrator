# ChatGPT Web browser PAIR fallback

This core transport is an explicit personal fallback for a WCO run when the normal bundled Codex provider is out of allowance.

It drives the user's own local Chromium browser session through the Chrome DevTools Protocol. It does **not** read ChatGPT cookies/tokens, call private ChatGPT HTTP endpoints, bypass CAPTCHA/protective measures, or transplant hidden provider context between unrelated conversations.

## Daily mode: Codex first, browser on quota exhaustion

Arm the fallback before starting WCO:

```bash
WCO_CHATGPT_BROWSER_FALLBACK=1 wco
```

Then use WCO normally and type a goal. Codex remains the fast path. If the **first provider turn of a logical thread** fails with a recognized Codex usage/quota exhaustion signal, WCO starts that thread in ChatGPT Web instead and keeps browser routing sticky for the rest of the WCO process.

This means the intended personal workflow is:

```text
goal
  -> Codex available: normal Codex path
  -> Codex allowance exhausted on first turn: ChatGPT Web browser path
       -> authoring
       -> implementation proposal
       -> local Harness mutation/verification
       -> independent review
       -> repair/review loop when needed
       -> Draft PR
```

Fallback is deliberately **quota-only**. Authentication failures, sandbox failures, schema failures, timeouts, interruptions, and unknown Codex failures do not select the browser.

If Codex allowance is exhausted only after an opaque Codex thread has already completed one or more turns, WCO fails closed with `WEB_CHATGPT_BROWSER_MID_THREAD_FALLBACK_UNSAFE`. The browser cannot safely reconstruct hidden conversation state that was never included in the durable WCO payload. Start the same goal as a fresh browser-fallback run instead.

## Browser-only qualification mode

To bypass Codex entirely for a fresh qualification/dogfood run:

```bash
WCO_CHATGPT_BROWSER=1 wco
```

`WCO_CHATGPT_BROWSER=1` takes precedence if both browser flags are present.

The normal path remains unchanged when neither flag is present.

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
- `WCO_CHATGPT_BROWSER_CONTEXT_BYTES` — implementation context-pack ceiling, default `6291456`, maximum `12582912`.

## Runtime flow

The browser transport reuses the existing WCO authoring, exact repository-read, implementation, verification, final-review, and Draft-PR state machine. Only the provider turn boundary changes.

A new browser provider thread creates a new ChatGPT conversation. WCO stores the resulting `https://chatgpt.com/c/...` URL as the provider `thread_id`; a continuation turn reopens exactly that URL. Independent review therefore remains a distinct provider thread.

Semantic author/reviewer turns continue to use WCO's bounded repository-command protocol. The implementation planner cannot see the local filesystem, so WCO creates one temporary context attachment containing:

1. accepted Task Bundle text files;
2. repository text files admitted by `manifest.json.allowed_paths`;
3. no file matched by `forbidden_paths`;
4. no obvious credential material such as `.env*`, `.npmrc`, private keys, or certificate/key containers.

The context export is bounded by file count, per-file size, and total bytes. It fails closed rather than silently truncating an implementation context.

After ChatGPT returns structured output, WCO parses and revalidates it through the same existing bridge schemas before any Harness mutation authority is granted.

## Protective behavior

The browser adapter intentionally fails if it detects a human-verification/protective page. There is no CAPTCHA solver, anti-bot bypass, rate-limit bypass, cookie extraction, or private endpoint fallback.

The adapter also refuses continuation URLs outside `https://chatgpt.com/`.

## Usage accounting

ChatGPT Web does not expose per-turn token telemetry to this adapter. The legacy provider ledger therefore records `0` input/cached/output tokens for a browser turn while still recording the provider turn and measured wall-clock duration. **Those zero token fields mean “unavailable to WCO”, not “ChatGPT used zero tokens”.** Browser/Plus product allowance is controlled by ChatGPT itself.

## Stability warning

This transport depends on the current ChatGPT Web DOM (`#prompt-textarea`, send/stop controls, assistant message attributes and attachment input). A ChatGPT UI change can break it. DOM mismatch is treated as a transport failure; WCO must not fall back to undocumented ChatGPT APIs.
