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

Separate limits are required for:

- Web/browser turns;
- Codex agent turns;
- deterministic verifier child processes;
- Git/network operations;
- mission-level runnable tasks.

Queued tasks consume minimal resources. Idle browser/session/worker resources have a TTL and are released. Cancellation must propagate to subprocesses.

Default policy should be conservative until native benchmarks are available. Phase 16 local performance smoke tests will establish platform-specific recommended defaults rather than assuming that a fixed concurrency is optimal for every machine/account/model.

## Process and output bounds

Every child process must have:

- timeout/deadline;
- cancellation;
- bounded stdout/stderr retention;
- process-tree termination where supported;
- explicit executable and argument vector (no shell interpolation by default).

WCO already uses bounded asynchronous spawning for execution paths; later orchestration must reuse it rather than introduce unbounded `exec`/sync polling loops.

## State/log bounds

Persistent state must not grow without a retention policy.

- receipts contain bounded diagnostics, not raw unbounded logs;
- raw logs/evidence are stored separately and content-addressed where useful;
- UI/status reads use summaries/indexes rather than deserializing every historical artifact;
- mission history is paginated/bounded;
- repeated identical errors are deduplicated with counters;
- completed temporary transport/session state is deleted.

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

## Performance regression requirements

Later phases must add executable coverage for at least:

- `PERF-001`: concurrency cap/backpressure prevents worker explosion.
- `PERF-002`: unchanged repository tree reuses project-map/inventory cache.
- `PERF-003`: one-blob change does not force full content re-ingestion.
- `PERF-004`: completed/cancelled worker releases process/session ownership.
- `PERF-005`: bounded status polling does not deserialize whole mission history.
- `PERF-006`: repeated identical diagnostics remain bounded.
- `PERF-007`: restart/backoff cannot become a hot restart loop.
- `TOKEN-001`: stable context is not duplicated inside one assembled prompt.
- `TOKEN-002`: context assembly honors byte/token approximation caps before model invocation.
- `TOKEN-003`: reviewer receives relevant diff/evidence, not implementation transcript by default.
- `TOKEN-004`: cache/usage telemetry distinguishes cached and uncached input when exposed.
- `TOKEN-005`: a transport retry reuses the same frozen request payload/hash.

## Native measurement

Repository CI can test algorithms and synthetic load, but final performance claims require native/local measurements on supported Windows/WSL/Linux configurations with the actual bridge/Codex runtime. `LOCAL-FINAL-CHECKLIST.md` will contain those commands before v1.0.

## References

- OpenAI, "How OpenAI uses Codex": https://openai.com/business/guides-and-resources/how-openai-uses-codex/
- OpenAI, "Harness engineering: leveraging Codex in an agent-first world": https://openai.com/index/harness-engineering/
- OpenAI, "Prompt Caching in the API": https://openai.com/index/api-prompt-caching/
- Git `git-status` documentation (untracked cache / FSMonitor): https://git-scm.com/docs/git-status
- Node.js child process documentation: https://nodejs.org/api/child_process.html
- `codex-chatgpt-web` public issue tracker: https://github.com/miuuyy/codex-chatgpt-web/issues
