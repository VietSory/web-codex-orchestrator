# v0.3 UX completion

> Historical phase note: the authoritative normal-user experience is defined by [`user-experience-contract.md`](user-experience-contract.md). Optional compatibility transports do not override that flow.

The current normal single-user path is local-first and intentionally small:

```text
Download the WCO release package
→ install it once
→ cd into your Git project
→ wco
→ authorize ChatGPT through the bundled official Codex sign-in on first use, if needed
→ type a goal
→ WCO prepares, implements, verifies, reviews, and creates the reviewed Draft PR
→ you decide whether to merge
```

After the first successful authorization, normal daily use is simply:

```bash
cd /path/to/project
wco
```

Then type a goal. Normal users do not select a relay profile, configure Cloudflare/ngrok/VPS infrastructure, enter an API key, install an MCP connector, copy browser credentials, click a per-task Web button, or exchange Task/Result ZIP files manually.

PAIR is the default interactive mode. `/auto <goal>` starts AUTOPILOT. Both retain the same local repository authority, deterministic verification, recovery, and human-only merge/release boundary.

The interactive slash palette is for normal task control and diagnostics. Legacy spellings and advanced compatibility commands may remain accepted for existing users, but they are intentionally hidden from the default command-discovery surface when they are not part of the normal workflow.

Optional `web_native_mcp`, `managed_actions`, `personal_actions`, `actions_relay`, and `manual_file` profiles remain compatibility/operator paths only. They must be explicitly selected and are never an automatic fallback from the local ChatGPT/Codex transport.

`/history` shows bounded task history, `/review` summarizes verification/review/Draft-PR evidence, `/doctor` diagnoses local prerequisites, and `/web connect` retries the same official ChatGPT authorization when required.

`/uninstall` asks for confirmation, removes only re-attested WCO-owned resources, preserves source repositories and remote GitHub state, and schedules global npm package removal after the running WCO process exits when that installation mode is detectable.
