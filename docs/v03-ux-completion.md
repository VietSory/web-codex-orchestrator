# v0.3 UX completion

The normal interactive path is intentionally Web-first:

```text
cd project
wco
enter a rough goal
→ connect the WCO Senior Architect once if needed
→ WCO opens the configured GPT
→ click “Start my pending WCO task” in ChatGPT Web
→ WCO polls the authenticated relay, serves bounded exact-base reads, materializes and validates canonical artifacts, and continues execution
→ when Result Bundle review is ready WCO opens the GPT again and waits for the exact Web verdict
```

No Downloads/T3/manual ZIP handoff is required in this primary path. The v0.2 manual Task Bundle/Web Pack/verdict commands remain available for automation and fallback.

`/web connect` verifies the stable managed relay, performs one-time device/account authorization, and persists `managed_actions` configuration without service URLs or secrets. The scoped device credential is stored only in protected WCO-owned credentials; it is not written to the project or trusted config. The earlier personal bearer workflow remains available only as `/web connect --self-hosted`.

`/history` reads bounded durable task history, `/review` summarizes Terra/Sol/Result Bundle/published PR evidence, and `/config web` re-runs Web connection setup.

`/uninstall` asks for one confirmation, purges only re-attested WCO-owned resources, preserves source repositories and remote GitHub state, and schedules global npm package removal after the running WCO process exits when that installation mode is detectable.
