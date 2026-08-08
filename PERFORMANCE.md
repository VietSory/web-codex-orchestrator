# WCO Performance and Token Architecture

Performance is a product invariant, not a Phase 16 cleanup task. WCO must remain bounded and observable as repositories, missions, evidence and model context grow.

## Primary goals

1. Never create unbounded hot browser/agent/process concurrency.
2. Never rescan/reload/resend stable repository context solely because a new turn starts.
3. Separate stable, cacheable context from dynamic task context.
4. Make every expensive operation attributable in telemetry: wall time, bytes, tokens, cache hit/miss and retry reason.
5. Prefer content-addressed reuse over mutable polling caches.
6. Use backpressure: queued work is cheaper and safer than resource collapse.

## Upstream lessons incorporated

### codex-chatgpt-web

Relevant public incidents/limitations are tracked in `UPSTREAM-COMPATIBILITY.md`. WCO treats applicable bridge/session issues as negative requirements. Examples include stale tab ownership/cleanup, concurrent-session resource pressure, browser disconnects, runtime restart loops, cold-turn failures and command-capability mismatch.

### OpenAI Codex guidance

OpenAI recommends well-scoped tasks, a configured development environment, durable repository guidance through `AGENTS.md`, and a task queue/backlog. OpenAI's harness-engineering guidance explicitly argues for giving agents a repository map instead of a giant instruction manual because context is scarce and monolithic guidance becomes stale/noisy.

### Prompt caching

Stable prompt prefixes should be kept stable; per-task values belong late in the prompt/context. WCO records cached vs uncached input usage when the model/runtime exposes those counters. Cache hits are an optimization only, never authority.

### Git

For large repositories, `git status` may benefit from Git's untracked cache and FSMonitor where the installed Git/platform supports them. WCO must detect support before recommending/enabling these features and must not silently change a user's repository configuration in normal execution.

## Content-addressed project context

Stable repository context is keyed by immutable identity:

```text
repo tree SHA
  ├─ repository inventory
  ├─ project map
  ├─ symbol/module map
  ├─ persistent docs index
  └─ source/read receipts
```

A tree SHA hit reuses the map. A changed tree invalidates only data whose source object changed. Blob/object SHA is preferred to mtime.

Derived caches are never authority. They may always be deleted/rebuilt without changing decisions.

## Agent context policy

A normal implementation/review turn should contain:

- immutable run/task/spec/implementation-pack identities;
- relevant architecture/acceptance/prohibited-change decisions;
- exact operation paths and relevant source chunks;
- bounded verification failures that require action;
- remaining token/turn/time budget.

It should not automatically contain:

- the entire repository;
- complete prior chat transcripts;
- complete raw test logs;
- unchanged source files already available through a stable project map;
- all persistent project memory;
- evidence unrelated to the current operation/finding.

Additional context is retrieved on demand and receipt-bound.

## Token budget

Track at minimum:

```text
input_tokens
cached_input_tokens (when exposed)
output_tokens
reasoning_tokens (when exposed)
turn_count
retry_count
```

Budgets exist at:

- one agent turn;
- one task/revision;
- one mission;
- one review stage.

A retry caused by transport/session failure should reuse sealed context/evidence rather than regenerate repository summaries.

Trusted configuration can tighten model/resource budgets but cannot raise them beyond the product hard ceilings validated in `src/config/config-validator.ts`. This protects a technical operator from accidental typo-scale token/time/archive grants while still permitting much larger profiles than the repository defaults. These ceilings are safety rails, not usage recommendations.

## Stable-prefix layout

Model-facing context should be ordered approximately as:

```text
stable WCO role/policy
stable repository conventions / selected project-map material
stable locked architecture/spec references
--- dynamic boundary ---
current task/operation
current relevant source/diff
current verifier/reviewer findings
current budget/state
```

Do not inject timestamps/random IDs into the stable prefix unless required for correctness.

## Concurrency and backpressure

Concurrency is a configured bounded resource pool, not `Promise.all(all tasks)`.

Separate limits apply where those resource classes are present:

- Web/browser turns;
- Codex agent turns;
- deterministic verifier child processes;
- Git/network operations;
- mission-level runnable tasks.

Queued work consumes minimal resources. Cancellation must propagate to subprocesses or queued work. Idle native/browser resources are transport concerns and must be released according to the adapter's supported lifecycle rather than kept alive as WCO authority.

The repository-side default policy stays conservative. Platform-specific concurrency recommendations require the native measurements in `LOCAL-FINAL-CHECKLIST.md`; WCO does not claim one fixed browser/session concurrency value is optimal for every machine/account/model.

### Inbox stability batching

Phase 3 candidate-stability checks use shared observation rounds. The old candidate-serial shape could spend one full `poll_interval_ms` per candidate; at the default 2-second poll and 100 candidates, one extra observation round could therefore approach 200 seconds before repository preparation began. The current scanner sleeps once per observation round and refreshes metadata in chunks of at most 32 concurrent stats. Expensive `prepareTask`/Git mutation remains sequential and deterministic. Watch mode reuses candidate observations between scans and resets an observation when file metadata changes.

## Process and output bounds

Every child process must have:

- timeout/deadline;
- cancellation;
- bounded stdout/stderr retention;
- process-tree termination where supported;
- explicit executable and argument vector (no shell interpolation by default).

WCO uses one bounded asynchronous subprocess engine for both text and exact binary callers. The shared `GitRunner` defaults to a 120-second local-Git deadline, 300-second network-Git deadline and 16 MiB retained stdout/stderr per stream. Phase 6 binary Git evidence reuses the same process-tree boundary without decoding source/diff bytes as text and fails closed if the exact output exceeds the configured evidence limit.

No production source path should introduce raw unbounded `spawn`/`exec` merely because an older phase predates the durable controller.

## State/log bounds

Persistent hot state must not grow without a retention/compaction policy.

- receipts contain bounded diagnostics, not raw unbounded logs;
- raw logs/evidence are stored separately and content-addressed where useful;
- UI/status reads use bounded receipts/indexes rather than deserializing every historical artifact or Codex rollout;
- trusted config reads are allocation-bounded to 1 MiB and re-attest file identity while reading;
- Phase 3 root run receipts are capped at 1 MiB and Phase 4 execution receipts at 4 MiB;
- orchestration run-ledger reads are capped at 2 MiB and semantic validation walks only the bounded transition counters, diagnostics and compacted event tail before state can drive work;
- orchestration event history is compacted and repeated diagnostics are deduplicated with counters;
- Phase 4 execution/agent JSONL diagnostic lines are bounded to 256 KiB; oversized single diagnostics are represented by bounded truncation metadata rather than giant lines;
- execution journal sequencing reads only a bounded tail to validate the last sequence instead of rereading the full append-only journal on every transition;
- Web review/revision round discovery is bounded by the protocol's fixed round limits;
- completed temporary transport/session state is not lifecycle authority.

`agent-events.jsonl` remains append-only and does not yet have a total-file retention policy. Per-line size and total model work are bounded, so this is a forensic-storage lifecycle concern rather than an unbounded in-memory read path. Any future archive/retention policy must be explicit; WCO does not silently delete evidence to improve a benchmark.

## Incremental verification

A verification result may be reused only when all relevant identity inputs match exactly:

```text
command + argv
working-directory identity
environment-policy hash
relevant file/blob hashes
lock/dependency identity
verifier version/config
```

If any required identity is unknown, rerun. Never reuse merely because a command string looks the same.

## Measured GitHub runner profile

Raw GitHub Actions logs observed a representative pre-product-regression baseline on hosted Ubuntu/Node 20 of approximately:

- `npm ci`: 3–4s;
- TypeScript typecheck: ~0.5–0.6s;
- repository-wide unit/fake suite: ~78s;
- Phase 8 fake E2E: ~2.2s;
- build: ~0.6s;
- compiled CLI integration: ~2.9s;
- total: roughly ~98s, depending on hosted-runner load.

The longest files are mainly intentional lock/crash/Git-race tests (commonly 5–8s/file). This CI cost is not representative of read-only `status`/`next` operator latency.

## Phase 16 regression coverage

The final repository gate covers the performance/token invariants that WCO can prove without a user's native browser/Codex environment:

- concurrency caps and explicit backpressure through bounded resource-pool regressions;
- shared-round inbox stabilization and watch observation reuse;
- bounded Git deadlines/output and exact binary Git evidence;
- bounded trusted config/root-run/execution-receipt reads;
- bounded execution/agent diagnostic lines and bounded-tail event sequencing;
- trusted resource/token hard ceilings;
- bounded ledger/event/diagnostic state and durable retry/circuit behavior;
- semantic ledger tamper cases are rejected before contradictory status/retry/budget state can trigger external work;
- exact sealed request hashes across retry/recovery paths;
- status/snapshot discovery from bounded protocol receipts rather than whole session history;
- no redundant local implementer turn for Phase 10 Web-authored bytes;
- revision model/token usage charged once into the outer orchestration budget;
- reviewer context separated from implementation transcript and bound to the exact change-set;
- retry classification for timeout/network/rate-limit/unavailable classes without hot-retrying policy failures;
- unexpired retry backoff is enforced before external Web pack/verdict files are re-read or canonicalized, after completed-side-effect recovery has had a chance to adopt exact receipts;
- terminal `BLOCKED`/`FAILED`/`COMPLETE` ledger state is checked before external Web pack/verdict reads, so callers cannot turn a terminal run into repeated untrusted-input CPU/I/O work.

Content-addressed repository inventory/project-map and source-read receipts remain the reusable context mechanism established by the Web Authority protocol. Cache reuse is never authorization; exact source/tree identity remains mandatory.

Native-only properties—real browser/session latency, native sandbox startup, Codex resume behavior, bridge capability reporting and machine-specific concurrency ceilings—are deliberately not claimed by GitHub CI.

## Native measurement

Repository CI tests algorithms, bounded state and synthetic/fake execution. Final native measurements on the user's supported Windows/WSL/Codex/bridge installation are listed in `LOCAL-FINAL-CHECKLIST.md`. Those checks return versions, timings, capability summaries, exit codes and sanitized diagnostics without making raw transcripts or credentials part of WCO authority.

## References

- OpenAI, "How OpenAI uses Codex": https://openai.com/business/guides-and-resources/how-openai-uses-codex/
- OpenAI, "Harness engineering: leveraging Codex in an agent-first world": https://openai.com/index/harness-engineering/
- OpenAI, "Prompt Caching in the API": https://openai.com/index/api-prompt-caching/
- Git `git-status` documentation (untracked cache / FSMonitor): https://git-scm.com/docs/git-status
- Node.js child process documentation: https://nodejs.org/api/child_process.html
- `codex-chatgpt-web` public issue tracker: https://github.com/miuuyy/codex-chatgpt-web/issues
