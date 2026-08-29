# Agent handoff: real PAIR browser proof

Use exact candidate SHA from Draft PR #73. Do not merge or release.

1. Confirm the Windows `miuuyy/codex-chatgpt-web` launcher is release 3.0.3, running, signed into ChatGPT, and its own browser smoke test passes.
2. From WSL, check out the exact PR head and run the repository's normal deterministic qualification if the head changed after GitHub CI.
3. Run `wco setup --yes --provider chatgpt-web`, then `wco web status`, then `wco doctor --mode PAIR`.
4. Prove one real provider turn reaches `Windows launcher helper -> fresh ChatGPT Temporary Chat` without WSL CDP/network changes and without Codex provider/model usage.
5. Run one complete PAIR goal through authoring, implementation proposal, WCO apply, deterministic verification, fresh independent ChatGPT Web reviewer, exact reviewed HEAD push, and Draft PR creation.
6. Capture evidence: exact WCO SHA, installed miuuyy `releaseVersion`, launcher/browser smoke status, provider status/doctor output, author/implementation/reviewer outcomes, reviewed change-set digest, pushed exact HEAD, Draft PR URL, and Codex usage before/after if visible.
7. Stop immediately on provider fallback, Codex invocation, non-Temporary Chat, helper/DOM drift, capability mismatch, verification failure, reviewer bypass, reviewed-head mismatch, or any request to change `.wslconfig`, firewall, portproxy, or merge/release.

Success means browser-qualified PAIR only. It does not authorize merge or release.
