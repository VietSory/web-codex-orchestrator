# PAIR browser dogfood through miuuyy launcher helper

This qualification path keeps WCO in WSL/Linux for bundle validation, Bubblewrap verification, Git and publication authority, while ChatGPT Web model turns execute inside the Windows-native launcher installed by `miuuyy/codex-chatgpt-web` 3.0.3.

The qualified upstream provenance is release `3.0.3`, commit `2569603f950de3a123e31bd26e7c8757566066f3`. WCO reads the installed launcher config, validates `releaseVersion=3.0.3`, reads the launcher-owned browser descriptor, then starts the descriptor's own browser helper over stdin/stdout. WCO never connects to the launcher's CDP or control loopback endpoint from WSL.

## Required local state

1. Install the Windows x64 launcher for `miuuyy/codex-chatgpt-web` 3.0.3.
2. Open the launcher, sign in to ChatGPT in its embedded browser, and run its browser smoke test.
3. Keep the launcher running while WCO PAIR runs.
4. In WSL, select the WCO provider explicitly:

```bash
wco setup --yes --provider chatgpt-web
```

The normal Windows installation writes `%USERPROFILE%\\.codex-chatgpt-web\\config.json`; WCO discovers that file through WSL interop. For a non-default launcher home, point WCO at the Windows or WSL-visible config explicitly:

```bash
export WCO_CHATGPT_WEB_MIUUYY_CONFIG='C:\\path\\to\\.codex-chatgpt-web\\config.json'
```

Optional model selection for PAIR provider turns:

```bash
export WCO_CHATGPT_WEB_COMPANION_MODE=high
```

Allowed values are `instant`, `medium`, `high`, `extra-high`, `pro`, and `luna`. Account capability mismatches fail closed.

## Proof sequence

Run these from the WSL checkout that contains the exact candidate under qualification:

```bash
wco web status
wco doctor --mode PAIR
wco
```

The interactive dogfood is successful only if all of the following are observed:

- `wco web status` reports ChatGPT Web browser PAIR and does not require Codex provider quota.
- Doctor reaches the installed miuuyy launcher helper and verifies an authenticated real ChatGPT Temporary Chat.
- No `.wslconfig`, firewall, portproxy, mirrored networking, private ChatGPT endpoint, cookie copy, or Codex authentication is required.
- The author/semantic phase uses ChatGPT Web.
- The implementation proposal uses the same Windows-native helper boundary and returns WCO's bounded operation schema.
- WCO alone applies the proposal and runs deterministic verification in its normal Linux harness.
- The independent reviewer starts from a fresh WCO logical thread and also uses the miuuyy helper transport.
- Reviewer APPROVE/REVISE is bound to the exact verified change-set before publication.
- The reviewed exact HEAD is what WCO pushes to a Draft PR.
- No merge or release occurs.

For quota proof, record Codex usage immediately before and after the dogfood if that UI is available. Browser PAIR is expected to make zero Codex provider/model turns; ChatGPT Web account usage may change because the actual model turns happen there.

## Fail-closed behavior

WCO refuses this path when the installed release is not 3.0.3, the launcher descriptor is malformed or absent, helper files are absent, the launcher session is not authenticated Temporary Chat, live account capabilities disagree with saved launcher capability state, helper protocol output is malformed, or the provider turn exceeds its deadline.

On WSL, WCO explicitly forwards the two Electron helper-mode variables through `WSLENV` with the `/w` direction. This prevents the descriptor's Electron executable from accidentally starting as the desktop app when it is intended to execute the launcher helper script.

The old direct WSL-to-Windows CDP path is not used when a qualified miuuyy installation is discovered. It remains only as a compatibility path for environments without the launcher and must not be treated as proof for this qualification.
