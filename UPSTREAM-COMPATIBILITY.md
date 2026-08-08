# Upstream Compatibility and Negative Requirements

WCO integrates with external browser/Codex software without making those implementations part of WCO authority. This file records current documented upstream behavior and public failure reports that materially influence WCO's defensive design.

A public issue report is evidence of a failure mode, **not** proof that every current installation is affected. WCO keeps generally useful regression requirements even when an upstream release later fixes the originating report.

## Ownership classes

- **WCO-owned:** lifecycle state, sealed request identity, retry/backoff, concurrency fencing, bounded logs/state, external-mutation reconciliation, Git/GitHub authority and WCO receipts. These must have executable tests where practical.
- **Adapter/bridge compatibility:** browser/session/capability/transport behavior WCO can probe or fail safely around, but does not control internally.
- **Codex-owned:** OpenAI Codex app/CLI/SDK/session/model/runtime internals. WCO can avoid unsafe assumptions and surface diagnostics; it does not patch/fork those internals.

## Current codex-chatgpt-web boundary

The current upstream README describes these important properties:

- Codex remains the local source of truth for task history.
- Browser model turns use fresh ChatGPT Temporary Chats rather than reusing a normal browser conversation as task history.
- Browser turns are serialized to protect one browser profile and prevent transcript reuse across tasks.
- UI/capability drift is intended to fail explicitly rather than silently switching behavior.
- Operations expose `codex-chatgpt-web doctor`, `service status`, `browser check`, and in full mode `tunnel status`.
- Browser login/profile state is sensitive and must not be copied into WCO logs/evidence.
- The current documented managed background installation is macOS-only; Windows/WSL support must not be inferred from older reports or from WCO CI.

WCO therefore does not use a browser tab/chat/sidebar as durable mission state. An installed bridge may transport a turn, but a browser response or session identifier cannot authorize implementation, publish, Web verdict or revision by itself.

## Codex session/history failure evidence

### Large-session picker/list pressure

OpenAI Codex issue #25430 reports that an interactive resume picker can hang with large local session files while direct `resume <id>` still works. Issue #19517 separately reported slow resume listing when many rollout files must be scanned.

**WCO requirement:** persist/directly reuse only the specific transport handle needed by the adapter. Do not scan the global Codex session list or interactive picker to discover WCO lifecycle state.

### Huge rollout memory growth

Issue #30932 reports a ~19.1 GiB rollout dominated by repeated compacted records causing `codex resume <thread-id>` memory growth and SIGKILL/OOM.

**WCO requirement:** WCO state/log/evidence remains independently bounded. WCO does not copy Codex rollout history into its ledger or require an immortal Codex thread for crash recovery. Native Codex history size remains an upstream/local operational boundary.

### Session index visibility divergence

Issue #28068 reports Windows session files remaining on disk while disappearing from `resume --all`/Desktop sidebar; direct resume by extracted ID still worked. Issue #31074 reports stale session-index entries that resolve to missing rollout files.

**WCO requirement:** sidebar/list visibility is never authority. WCO lifecycle uses its own bounded receipts and exact hashes. A missing/unavailable upstream session is a compatibility failure, not permission to construct a replacement history from guesses.

### Model/reasoning drift on resume

Issue #32061 reports resumed sessions selecting current `config.toml` model/reasoning rather than automatically restoring the prior session's values.

**WCO requirement:** model/reasoning policy comes from the trusted WCO configuration/current adapter contract, not from assumptions about what a resumed upstream thread remembers.

### Persistence divergence

Issue #35385 reports Codex 0.145.0 code paths where rollout persistence I/O errors may be logged/discarded, leaving in-memory state newer than durable on-disk state before a crash.

**WCO requirement:** Codex session history is not recovery authority. WCO checkpoints before external work and adopts only exact WCO-owned terminal receipts/evidence. WCO critical receipts use explicit synced persistence where WCO owns the file format.

### Lost post-tool continuation / uncertain external write

Issue #35658 reports ChatGPT Work web turns that sometimes stop around connector/tool boundaries, including an observed case where an external write had committed even though the turn continuation/result was lost.

**WCO requirement:** external mutation success is never inferred from chat continuation. Mutation transitions have durable `STARTED` identity and a reconciliation/adoption path that reads canonical external/WCO evidence before deciding whether another mutation is safe.

## WCO compatibility pattern

For applicable external operations WCO follows:

```text
validate immutable authority
→ seal canonical request hash
→ checkpoint STARTED attempt
→ execute one bounded external operation
→ re-attest exact result/receipt
→ complete durable attempt
```

On disconnect/crash:

```text
read exact STARTED attempt
→ reconcile canonical external/WCO evidence
→ adopt only if exact terminal authority matches
→ otherwise leave resumable/waiting or fail closed
```

It does **not** use:

- browser conversation continuity as authorization;
- Codex sidebar/resume-picker contents as lifecycle discovery;
- model text saying "done" as proof a Git/GitHub mutation committed;
- a missing external result as permission to repeat a create/push blindly;
- unbounded automatic restart loops.

## GitHub compatibility/backpressure

GitHub documents primary and secondary REST rate limits and instructs clients to honor `Retry-After` or reset headers and back off. WCO serializes orchestration mutations, keeps a hard response-body cap, converts valid server hints into a bounded durable retry floor, and refuses to wait beyond the remaining orchestration elapsed budget.

GitHub redirect behavior is intentionally stricter in the Draft-PR client than generic REST guidance because an unexpected redirect changes the credential/destination trust boundary. WCO rejects redirects rather than automatically following them with an authorization header.

## Diagnostics posture

Normal status paths are compact and do not start model/browser work. Retained diagnostics use bounded messages/counters/request hashes rather than full transcripts or browser profiles. Secrets, cookies, authorization headers and browser-login storage are never valid evidence payloads.

Screenshots/raw browser traces may be useful native failure diagnostics, but they are not normal lifecycle state and must not be required to determine whether a WCO transition is complete.

## Final local compatibility proof

GitHub CI cannot prove the user's actual native Codex authentication/sandbox, Windows/WSL behavior or installed bridge support. The remaining checks are intentionally isolated in `LOCAL-FINAL-CHECKLIST.md`. A local incompatibility does not authorize weakening WCO's frozen security/recovery contracts; it is returned as a compatibility diagnostic.

## References

- `codex-chatgpt-web` current README: https://github.com/miuuyy/codex-chatgpt-web
- OpenAI Codex issue #25430: https://github.com/openai/codex/issues/25430
- OpenAI Codex issue #19517: https://github.com/openai/codex/issues/19517
- OpenAI Codex issue #30932: https://github.com/openai/codex/issues/30932
- OpenAI Codex issue #28068: https://github.com/openai/codex/issues/28068
- OpenAI Codex issue #31074: https://github.com/openai/codex/issues/31074
- OpenAI Codex issue #32061: https://github.com/openai/codex/issues/32061
- OpenAI Codex issue #35385: https://github.com/openai/codex/issues/35385
- OpenAI Codex issue #35658: https://github.com/openai/codex/issues/35658
- GitHub REST rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- GitHub REST best practices: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
