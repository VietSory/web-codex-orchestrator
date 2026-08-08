# Professional Product Audit — Phase 1 through Phase 16

## Scope and method

This audit intentionally discarded the earlier Phase 16 maintainer-audit conclusions and treated the repository as an unfamiliar technical product being evaluated for daily professional use.

The audit reviewed Phase 1 through Phase 16 from four independent evidence classes:

1. **Executed GitHub evidence** — raw GitHub Actions logs on the exact PR head: dependency install, pinned Codex packages, template validation, TypeScript strict typecheck, repository-wide unit/fake tests, Phase 8 fake end-to-end, build and compiled CLI integrations.
2. **Executable regression evidence** — security, crash, race, retry, path, resource, CLI and performance regressions checked into the repository and included in the release gates.
3. **Code/document audit** — direct reading of the runtime implementations, stores, subprocess boundaries, phase contracts, README, security/performance documentation and CLI surfaces.
4. **Local-only evidence** — Windows/WSL/native Codex/`codex-chatgpt-web` behavior that GitHub CI cannot honestly prove. Those checks remain in `LOCAL-FINAL-CHECKLIST.md` and are not counted as PASS here.

A green status or an old audit statement was not accepted as authority by itself. During this audit the CI workflow itself was found to be checking out GitHub's synthetic PR merge ref rather than the exact PR head; that was fixed first, and later evidence is required to assert and test the exact event-head SHA.

## Product verdict

WCO is now a strong **private technical preview / maintainer-operated product**. Its strongest qualities are authority separation, fail-closed recovery, exact Git/GitHub identity, deterministic verification/review and bounded autonomous behavior. The fresh audit materially improved operator UX and hot-path resource behavior rather than merely documenting existing architecture.

It is **not yet a public release**. Two release decisions remain outside deterministic GitHub proof:

- the root `LICENSE` is empty; the maintainer must explicitly choose a license/distribution policy;
- the target Windows/WSL/native Codex/bridge environment must complete `LOCAL-FINAL-CHECKLIST.md`.

No release, deployment, Mark Ready, auto-merge or merge should be inferred from this report.

## Quality scorecard

| Area | Score | Assessment |
| --- | ---: | --- |
| Security / authority | **9.2 / 10** | Exact registered authority, stable/bounded reads, no loose-chat implementation authority, fail-closed Git/GitHub and recovery boundaries. |
| Reliability / recovery | **9.0 / 10** | Durable attempts, exact crash adoption, pause/retry/budget semantics, same-PR revision recovery and immutable evidence are unusually strong for a 0.1.0 source project. |
| Performance / resource discipline | **8.9 / 10** | Bounded process/state/token/resource behavior is strong after this audit; deliberate integrity re-attestation remains I/O-heavy by design. |
| CLI / operator UX | **8.5 / 10** | Source-checkout wrappers, run-independent doctor, canonical command names and concise human output make daily use much better; there is still no installer/TUI. |
| Test / verification quality | **9.1 / 10** | Broad fake/integration/crash/race coverage, exact-head CI and final product regressions. Native platform/model execution remains intentionally opt-in/local. |
| Private-preview readiness | **9.0 / 10** | Suitable for a technical maintainer willing to run the native checklist and retain human merge authority. |
| Public-release readiness | **BLOCKED** | Empty license and unproven target-machine native checks. |

These scores are product-quality estimates, not security certifications.

## Phase-by-phase findings

| Phase | Professional-user view | Fresh audit result |
| --- | --- | --- |
| **1 — Bundle validation** | Fast contract feedback before intake. | Validation behavior is strong, but the old success wording incorrectly implied execution readiness. It now states that the **contract is valid** and that secure intake/preparation still decides execution eligibility. Root CLI help was also made explicit. |
| **2 — Secure ZIP intake** | Untrusted download boundary. | Existing ZIP/path/size/checksum defenses remain appropriate. No payload execution was introduced. The audit kept these conservative checks instead of trading them for latency. |
| **3 — Prepare / inbox** | Repository selection, stable download observation and isolated worktree creation. | Largest direct latency fix: stability waiting was candidate-serial. At defaults, 100 candidates could pay roughly 100 × 2s for one extra observation round. Candidates now share each wait round, metadata refresh is chunked with bounded concurrency (32), while expensive prepare/Git mutation remains serial. Watch mode reuses stability observations between scans. Root `run.json` reads are now allocation-bounded to 1 MiB. |
| **4 — Implement / verify / Terra / Sol** | Model-bearing work and deterministic gate. | Prompt/evidence context is bounded, implementer thread resumes rather than replaying transcripts, independent reviewers use fresh read-only threads and both bind the same digest. Execution receipts are now capped at 4 MiB. Append-only journal sequencing now reads only a bounded tail instead of rereading the entire journal on every transition; individual diagnostic events are bounded without deleting history. |
| **5A — Commit / push** | Exact approved change-set publication. | Integrity re-attestations were kept. Shared Git execution now has hard deadlines and output caps. Normal Phase 5A temporary askpass helpers are removed in `finally`; token material remains environment-only. Documentation now accurately describes the empty expected-value lease as create-if-absent CAS, not destructive force-update authority. |
| **5B — Draft PR** | One exact open Draft PR, no merge authority. | Existing Draft/head/base/repository attestation remains strong. No Ready/merge/auto-merge path was added. |
| **6 — Result Bundle** | Reproducible handoff for independent Web review. | A legacy raw `spawn("git")` path had no timeout/output bound and binary output used unbounded concatenation. It now uses the same bounded process-tree engine as other subprocesses; binary evidence stays exact bytes and fails closed on timeout/truncation. Result-Bundle resource limits also have hard product ceilings. |
| **7 — Web verdict** | Explicit external review decision. | Existing verdict reads were already a good reference design: bounded, stable, canonical and freshly GitHub-attested. The schema test compiler now matches production (`strict:false`) so CI no longer emits misleading strict-mode warning spam while semantic assertions remain intact. |
| **8 — Same-PR revision** | Bounded correction without replacement PR/spec drift. | Existing exact-head, path, verifier, Terra/Sol, fast-forward and Result-Bundle chain remains strong. The new resource ceilings were adjusted to preserve the already-tested 50 MiB source-evidence profile while retaining a 64 MiB hard source-file ceiling. |
| **9 — Web Authority** | Registered implementation authority. | Command naming was inconsistent across binary usage/README/tests. Canonical user commands are now `wco-web-authority register` and `status`; legacy names remain aliases for automation compatibility. |
| **10 — Constrained executor** | Apply exact registered bytes, no redundant local implementation turn. | Strong cost/authority design. It avoids a second implementer-model turn and uses deterministic verification plus independent read-only reviews. No weakening was needed. |
| **11 — Durable control plane** | Main operator surface. | Human output previously dumped ledger JSON and `doctor` unnecessarily required a run ID. `doctor` is now a run-independent bounded preflight for Node/state/config/credential-key presence/Git/pinned Codex/login status. Status/next/continue/pause/resume have concise human output while `--json` retains full machine contracts. Phase 11 docs were updated accordingly. |
| **12 — Draft PR orchestration** | Durable external GitHub transition. | Exact Draft PR state remains lower-layer-authority driven; no model/session scan or duplicate GitHub mutation implementation was introduced. |
| **13 — Result orchestration** | Package exact published Draft head. | Reuses hardened Phase 6 authority. Phase 6 subprocess bounds now also protect this durable path. |
| **14 — Verdict orchestration** | Seal explicit Web verdict into durable lifecycle. | Bounded canonical input, exact digest checkpointing and recovery-first behavior remain correct. No browser/transcript scraping was introduced. |
| **15 — Revision orchestration** | Durable same-PR revision loop. | Exact Phase 7/8 authority, result adoption and outer token accounting remain strong. No duplicate revision implementation path was created. |
| **16 — Final hardening** | Product-level consistency and release boundary. | Added exact-head CI, terminal/retry/state hardening from prior work, plus this audit's performance/resource/CLI/onboarding fixes and explicit release blockers. |

## Measured performance and cost behavior

### GitHub CI baseline

Raw hosted-runner logs observed approximately:

- dependency install: **3–4 seconds**;
- TypeScript typecheck: **~0.5–0.6 seconds**;
- full repository unit/fake suite: **~78 seconds**;
- Phase 8 fake E2E: **~2.2 seconds**;
- build: **~0.6 seconds**;
- compiled CLI integration: **~2.9 seconds**;
- baseline total: roughly **~98 seconds**, varying with hosted-runner load.

The longest unit files are mostly intentional crash/lock/Git-race tests (often 5–8 seconds per file), not normal `status` or planning hot paths.

### Hot-path improvements from this audit

**Inbox stability:** previous waiting cost scaled with candidate count because each candidate slept independently. With `poll_interval_ms=2000` and 100 candidates, a single extra observation could cost roughly ~200 seconds of serial wait. Waiting is now shared by observation round, so the same round is approximately the configured ~2-second wait plus bounded metadata I/O. Repository preparation and Git mutation remain serial to preserve deterministic isolation.

**Git hangs/RAM:** all shared Git execution now has hard local/network deadlines and bounded stdout/stderr. Phase 6 binary Git evidence also uses a bounded exact-byte process engine. A command that exceeds the boundary fails rather than feeding partial output into identity/evidence calculations.

**State growth:** root-run and execution receipts are allocation-capped. Execution event sequencing no longer rereads the entire append-only journal to count lines on every transition; it reads a bounded tail and validates the last sequence. Large single diagnostic events degrade to small `truncated/original_bytes` metadata rather than producing giant JSONL lines.

**Tokens:** Phase 10 avoids a redundant local implementation turn. Implementer threads resume with bounded correction prompts; independent reviewers are fresh. Outer and trusted hard ceilings constrain turns/time/input/output tokens, while a task bundle can only tighten effective work. The product does not replay whole Codex/browser histories to discover lifecycle state.

## Operator experience

From a source checkout the supported path is now:

```bash
npm ci
npm run build
npm run doctor -- --state-dir <state> --config <config.json>
npm run wco -- --help
npm run web-authority -- register ...
npm run control -- continue ...
npm run control -- status ...
```

A global `npm link` is optional rather than a hidden prerequisite. Human output is concise; scripts can opt into `--json`.

`doctor` intentionally does not start a model turn or perform a full live GitHub/repository mutation test. It is a fast machine preflight. The full native/sandbox/bridge checks remain explicit local acceptance tests.

## Security/resource ceilings added by the audit

Trusted configuration can choose lower limits, but cannot grant unbounded work. Current hard ceilings include:

- inbox: 10,000 candidates/scan, 16 stability observations, 60s poll interval, 1h stable-age;
- agent workflow: 64 implementation iterations, 32 Terra rounds, 16 Sol rounds, 128 total turns, 2h/turn, 24h total, 20M input and 4M output tokens;
- Result Bundle: 4096 entries, 64 MiB entry/source/diff, 512 MiB uncompressed, 256 MiB archive, bounded public-command and GitHub-response payloads;
- trusted config source: 1 MiB stable-read cap;
- root run receipt: 1 MiB;
- execution receipt: 4 MiB;
- execution/agent diagnostic event line: 256 KiB;
- Git: 2-minute local / 5-minute network command deadlines and 16 MiB text streams by default.

These are safety ceilings, not recommended operating targets.

## Remaining limitations and debt

### Release blockers

1. **License/distribution policy** — root `LICENSE` is empty. WCO must not invent the maintainer's legal choice.
2. **Native target validation** — Windows/WSL/native Codex/bridge behavior remains local-only and must pass `LOCAL-FINAL-CHECKLIST.md`.

### Non-blocking product debt

- No installer/TUI/desktop front end; this remains a technical CLI/source product.
- Append-only `agent-events.jsonl` has no total retention policy. Per-line diagnostics and total model work are bounded, so this is a long-running forensic-storage concern rather than an immediate memory hazard. A future retention/archive policy should be explicit rather than silently deleting evidence.
- `doctor` does not make every repository/GitHub network call; destructive or credential-bearing live checks belong to explicit workflows/local validation.
- The trusted reasoning-effort type intentionally stops at the frozen supported set used by this project rather than automatically opting into newer/more expensive effort modes. New cost tiers should be an explicit contract change.
- Conservative re-attestation causes repeated filesystem/Git reads around publication/recovery. Those reads are intentional race/authority protection and were not removed merely to improve benchmarks.

## Final acceptance rule

The product-audit report is valid only for an exact head that:

1. remains on the Draft Phase 16 PR;
2. passes exact-head GitHub CI after all report/document changes;
3. keeps the frozen human-only merge boundary;
4. leaves only the explicit license and local-native acceptance decisions above.

If code changes after that head, the relevant executed evidence must be rerun; this report is not authority for a different commit.
