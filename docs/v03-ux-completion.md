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

PAIR is the default collaborative mode. While WCO is still refining the plan, the user can type additional details; WCO pauses the same single background owner at a safe boundary, adds the clarification only while the plan is still unlocked, and continues the same durable task. `/auto <goal>` starts AUTOPILOT for a goal that is already clear and should continue end-to-end unless a real decision needs the user. Both retain the same local repository authority, deterministic verification, recovery, and human-only merge/release boundary.

The interactive slash palette is for normal task control and diagnostics. It presents user-facing ChatGPT authorization commands as `/auth status` and `/auth connect`; these are compatibility aliases over the existing authorization handler, not a new transport or credential path. Legacy spellings and advanced compatibility commands such as `/web ...`, `/mode`, `/config`, and `/run` remain accepted for existing/power users but are intentionally hidden from default command discovery. Command discovery is context-aware: while a background worker owns mutation, the palette shows only commands that are safe and valid in that state instead of advertising commands that the runtime would reject.

Every normal progress/review surface should answer what the user needs to do next. When WCO owns the next step, it says so explicitly with `Your action: None — WCO ...`; when a decision or merge is needed, `Your action` names that action.

`/continue` is the normal one-step continuation command for the current unfinished saved task only. It never changes task focus by selecting historical work implicitly. If the current task is complete or no current task exists, the user starts a new follow-up goal or explicitly chooses saved work through `/resume`. A blocked current task remains current until the user resolves it with `/status`, `/review`, and `/doctor`, or deliberately switches through `/resume`. `/resume` opens the recent-task picker, and `/resume <number>` selects the matching history item after durable re-attestation.

A history JSON file is never trusted as workflow authority. WCO re-attests the exact canonical run receipt, run ledger, repository/base binding, and bounded task/implementation artifacts before changing current focus. Completed tasks remain completed and require a new follow-up goal; authoring-only, stale, corrupt, mismatched, redirected, or symlinked history remains inspectable/reference-only instead of inventing runnable state.

Starting `/new` or `/auto` while an unfinished task is in current focus requires confirmation. Switching to a different resumable historical task also requires confirmation when another unfinished task—including a blocked one—is currently focused. Existing durable progress is archived before the focus switch and no background mutation owner is allowed to race the transition. `/history` and `/history <number>` remain read-only inspection surfaces; `/resume` is the separate explicit action that can change current focus after re-attestation.

The live composer follows normal terminal expectations: Ctrl+C cancels current input or safely interrupts the active background task while keeping WCO open; Ctrl+D requests a safe exit; Ctrl+J or Shift+Enter inserts a newline; pasted multiline goals/clarifications preserve their line breaks; Ctrl+R searches backward through bounded prompt history; background output redraws without taking stdin ownership away from the user. Arrow-key history and slash completion remain bounded to the interactive session.

Before a local task starts or resumes, WCO reuses the existing mode-aware `doctor` readiness checks after ChatGPT authorization. This prevents normal work from starting when required local prerequisites for the selected mode are unavailable, without introducing a second readiness engine.

Optional `web_native_mcp`, `managed_actions`, `personal_actions`, `actions_relay`, and `manual_file` profiles remain compatibility/operator paths only. They must be explicitly selected and are never an automatic fallback from the local ChatGPT/Codex transport.

`/status` shows current progress and `Your action`, `/review` summarizes verification/review/Draft-PR evidence, `/continue` continues saved progress, `/resume` chooses a saved task, `/history` inspects recent tasks, `/doctor` diagnoses local prerequisites, `/auth status` shows ChatGPT authorization state, and `/auth connect` retries the same official ChatGPT authorization when required.

`/uninstall` asks for confirmation, removes only re-attested WCO-owned resources, preserves source repositories and remote GitHub state, and schedules global npm package removal after the running WCO process exits when that installation mode is detectable.
