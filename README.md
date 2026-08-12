# Web Codex Orchestrator

[![CI](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/VietSory/web-codex-orchestrator/actions/workflows/ci.yml)

**Let ChatGPT Web author bounded changes, let WCO own every mutation, verify the exact result, and keep merge/release human-owned.**

Web Codex Orchestrator (WCO) is a durable local CLI for medium and large AI-assisted coding jobs. It separates **authority** from **execution**:

- ChatGPT Web can inspect the exact repository/base and author bounded implementation or repair operations.
- The WCO Harness validates preimages, paths and postimages, applies the exact operations, and owns every filesystem mutation.
- Deterministic verification runs in an isolated network-disabled sandbox.
- AUTOPILOT may use exactly one frozen Sol/Terra code-review pass; PAIR does not require Codex at all.
- The original ChatGPT Web session performs the mandatory final intent review of the exact published Draft PR head.
- WCO never merges, marks ready, enables auto-merge, force-pushes, deploys or releases on the normal flow.

## Two product modes

### PAIR — zero Codex requirement

PAIR is the default for a plain goal or `/new <goal>`.

```text
user goal
→ original ChatGPT Web (Web-A) inspects exact repository/base
→ Web-A seals architecture + bounded implementation operations
→ WCO Harness validates/applies exact operations
→ deterministic verification (Bubblewrap, network disabled)
→ independent Web code review (Web-B)
   ├─ APPROVE
   ├─ REVISE + bounded repair operations → Harness apply/re-verify → Web-B again
   └─ consequential/policy boundary → NEEDS YOU
→ exact fast-forward publication
→ same open Draft PR + exact Result Bundle
→ original Web-A mandatory final intent review
   ├─ APPROVE
   ├─ REVISE + bounded repair operations → Harness apply/re-verify
   │                                  → same Draft PR/new Result Bundle → Web-A again
   └─ ESCALATE → NEEDS YOU
→ READY FOR YOU
→ human reviews/merges
```

PAIR never creates a Codex model client, never requires Codex authentication, and never invents a Terra/Sol approval. Web reviewers may propose bounded file operations; only the Harness mutates the worktree.

### AUTOPILOT — one adaptive model review pass by default

Start explicitly with:

```text
/auto Fix the authentication race condition and add regression tests.
```

```text
user /auto goal
→ original Web-A inspects exact repository/base
→ Web-A seals architecture + bounded implementation operations
→ WCO Harness validates/applies exact operations
→ deterministic verification
→ exactly one frozen Sol/Terra review pass (default Sol/high)
   ├─ APPROVE
   ├─ REVISE + bounded repair operations in the same pass
   │        → Harness apply/re-verify
   └─ consequential/policy boundary → NEEDS YOU
→ exact fast-forward publication
→ open Draft PR + exact Result Bundle
→ original Web-A mandatory final intent review
   ├─ APPROVE
   ├─ REVISE + bounded Web repair → Harness apply/re-verify
   │                            → same Draft PR/new Result Bundle → Web-A again
   │                            → no second Sol/Terra call
   └─ ESCALATE → NEEDS YOU
→ READY FOR YOU
→ human reviews/merges
```

The selected reviewer is frozen per run. The normal pipeline is **not** `Terra → Sol → Web`, and a final Web-A revision does **not** restart the model reviewer. This keeps latency and token usage bounded while preserving an independent final intent check.

## Why Harness-first

WCO treats model/Web output as proposed authority, never as direct mutation permission. Bounded operations are limited to `create_file`, `replace_file`, and `delete_file` with exact preimage/postimage bindings. The Harness applies them through the same transaction, rollback, path/symlink and change-set controls regardless of who proposed them.

This design deliberately parallelizes independent reads/research/attestations while serializing mutation and authority transitions. More agents are not automatically faster: WCO prefers one useful reviewer call with bounded repair output over review → repair → re-review chatter when one pass can safely express the correction.

## Requirements

For PAIR:

- Linux or WSL;
- Node.js 22 or newer and npm;
- Git;
- Bubblewrap (`bwrap`) for deterministic network-disabled verification;
- GitHub authentication for Draft PR delivery;
- a browser for one-time managed ChatGPT Web authorization.

AUTOPILOT additionally requires the pinned Codex runtime/authentication for the selected Sol/Terra code-review pass.

Use `/doctor` on an active task. It is mode-aware: PAIR does not fail merely because Codex runtime/auth is unavailable; AUTOPILOT checks the reviewer prerequisites it actually uses.

## Install the Latest release

The public release is resolved from GitHub **Latest**. The package is distributed as a checksummed GitHub release tarball and remains private on npm.

```bash
release_tag="$(gh release view --repo VietSory/web-codex-orchestrator --json tagName --jq '.tagName')"
release_version="${release_tag#v}"
release_asset="web-codex-orchestrator-${release_version}.tgz"
gh release download "$release_tag" --repo VietSory/web-codex-orchestrator --pattern "${release_asset}*"
sha256sum -c "${release_asset}.sha256"
npm install --global "./${release_asset}"
test "$(wco --version)" = "$release_version"
```

## Daily use

```bash
cd /path/to/project
wco
```

On first run WCO detects the repository and base, writes WCO-owned state/configuration, checks local prerequisites, offers the managed Web connection, and enters the interactive shell.

Then enter a normal-language goal:

```text
Add rate limiting to POST /login, preserve existing login behavior, and add regression tests.
```

That starts PAIR. Use `/auto <goal>` when you want the optional single Sol/Terra review pass.

### Reviewer policy for AUTOPILOT

Default:

```text
Sol · high
```

Inspect or change the preference for **new AUTOPILOT tasks**:

```text
/mode
/mode sol high
/mode terra medium
/mode terra xhigh
```

Supported reasoning efforts are `minimal`, `low`, `medium`, `high`, and `xhigh`. `/mode` does not affect PAIR and never disables the mandatory original-Web final review.

## No manual ZIP workflow on the normal path

Normal PAIR/AUTOPILOT users do not create a Task Bundle, move a ZIP, copy a run ID, set a state directory, or invoke an internal Node entry point. WCO materializes and binds those artifacts internally for deterministic authority/recovery.

The Web bridge can request bounded repository summary/tree/search/read operations against the exact locked base. Repository text is treated as data, not instructions. After Web seals implementation authority, WCO validates it locally before the Harness can mutate anything.

## Review identities

WCO intentionally separates review responsibilities:

- **Web-A author/final reviewer:** the original ChatGPT Web task/session; owns architecture/intent and the final exact-head intent decision.
- **Web-B code reviewer (PAIR):** an independent Web review identity; checks correctness/security/regression/performance and may return bounded repair operations.
- **Sol/Terra code reviewer (AUTOPILOT):** exactly one frozen model reviewer on the normal path; may approve, escalate, or return bounded repair operations in its single adaptive pass.

A cached approval is never enough. `READY_FOR_YOU` is re-attested against the live exact Draft PR head.

## Discoverable commands

At the WCO prompt, enter `/` or `/help`:

```text
/new <goal>             start a different PAIR task
/auto <goal>            start an AUTOPILOT task
/mode                    show AUTOPILOT reviewer preference
/mode <model> <effort>   choose Sol/Terra + effort for new AUTOPILOT tasks
/status                  show current progress
/task                    show current goal/contract state
/run                     continue the active workflow
/web status              diagnose Web connection
/web connect             connect the managed Senior Architect
/web open                open the configured Web experience
/web disconnect          revoke/remove local device credential
/review                   show verification/review/result/Draft PR evidence
/pause                   stop before the next safe transition
/resume                  clear an explicit pause
/history                 show bounded repository task history
/config                  show user-facing settings
/config web              reconnect managed Web
/doctor                  mode-aware prerequisite diagnostics
/uninstall               remove WCO-owned local resources
/unitsall                alias for /uninstall
/quit                    exit safely
```

Plain text before contract sealing is a clarification. After sealing, WCO refuses silent contract mutation and asks for a new task instead.

## Deterministic verification and isolation

PAIR verification uses Bubblewrap with network disabled and a bounded writable workspace. WCO does not fall back to unrestricted host execution when the required isolation is unavailable.

AUTOPILOT uses the same deterministic verification authority. The Sol/Terra reviewer is read/review authority; any repair it proposes is converted to bounded operations and applied by the Harness, then the exact new digest is re-verified before publication.

## Recovery and generations

WCO persists create-once/attested receipts around model calls and external side effects. If the terminal closes or the machine restarts, return to the repository and run:

```bash
wco
```

Use `/status` and `/run` to continue. `/resume` is only needed after an explicit pause.

Important recovery rules:

- ambiguous model calls are not blindly replayed;
- publication uses write-ahead/durable checkpoints and exact remote-head attestation;
- repairs are digest-chained to the exact review/result generation they answer;
- repaired publication is strict fast-forward on the same Draft PR, never force push;
- older publish/Result/review generations remain immutable evidence;
- a crash after push but before Result Bundle rotation is recovered by adopting exact durable publication authority, not by reconstructing trust from the current worktree;
- final Web-A revision produces a new immutable revision Result Bundle and returns to Web-A without another Sol/Terra call.

## Safety boundary

WCO preserves these invariants on normal interactive and automation paths:

- exact repository/base-commit binding;
- secure bounded archive/artifact intake;
- allowed/forbidden path enforcement;
- exact preimage/postimage verification;
- symlink/TOCTOU-resistant state and worktree reads/writes;
- network-disabled deterministic verification with no unrestricted fallback;
- exact change-set/evidence binding;
- bounded model turns/tokens and repair generations;
- mandatory original-Web final review before `READY_FOR_YOU`;
- exact remote URL/repository/base/head/Draft PR attestation;
- no direct protected-branch push, force push, auto-merge, Mark Ready, remote branch deletion, deploy or release;
- credential redaction and durable restart-safe receipts;
- fail-closed recovery when authority or side-effect state cannot be proven.

Both PAIR and AUTOPILOT stop at the human merge boundary.

See [SECURITY.md](SECURITY.md), [Architecture](docs/architecture.md), [Job modes](docs/job-modes.md), [Operations](docs/operations.md), and [Protocols](docs/protocols.md) for lower-level contracts.

## Advanced automation and compatibility

The packed CLI retains Task Bundle, Web implementation-pack, verdict, run-ID and explicit state/config commands for deterministic automation and backward compatibility. They are not required for normal interactive use.

Legacy Phase 4/Phase 8 execution surfaces remain compatibility code for older prepared runs. Normal Harness-first PAIR/AUTOPILOT flows do not use legacy model-owned mutation authority.

Run `wco --help` before building low-level automation.

## Development

```bash
git clone https://github.com/VietSory/web-codex-orchestrator.git
cd web-codex-orchestrator
npm ci
npm run check
npm run pack:check
npm run pack:smoke
npm run test:user:packed
```

Real native/provider gates are explicit and may consume provider usage:

```bash
WCO_RUN_SANDBOX_INTEGRATION=1 npm run test:native:sandbox
WCO_RUN_CODEX_INTEGRATION=1 npm run test:native:codex
```

Normal CI uses deterministic fakes/synthetic relay actors and does not prove a deployed managed relay or live hosted ChatGPT/provider path.

## Hosted-service deployment boundary

The repository contains the managed client, OAuth/device-flow contracts, reference relay behavior, GPT instructions/schema, and fail-closed managed metadata. A real stable relay/OAuth deployment, configured hosted Web experience, and real provider/hosted end-to-end acceptance remain external deployment gates and must be validated separately before claiming that hosted path is live.

## Uninstall

Inside WCO run `/uninstall` (or `/unitsall`) and confirm. From a shell:

```bash
wco uninstall --purge
wco uninstall --purge --yes
```

WCO removes only its canonical owned home and clean, re-attested managed worktrees. It preserves source repositories, uncommitted work, Git history, remote branches, Draft PRs and deployments.

## License

Apache License 2.0. See [LICENSE](LICENSE).
