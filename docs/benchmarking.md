# Benchmarking

WCO separates deterministic engineering benchmarks from provider-backed model experiments. They answer different questions and must not be presented as interchangeable evidence.

## Deterministic Smart Context benchmark

```bash
npm run benchmark:context
```

This benchmark is safe for CI. It uses synthetic bound authority metadata and measures only:

- selector execution time;
- candidate versus selected path counts;
- candidate versus selected path-metadata bytes;
- deterministic selection identity.

It does **not** measure Codex input tokens, output tokens, latency, cost, review quality, or task success. The script fails if the selector stops respecting its bounded-selection invariants.

## Native Codex A/B benchmark

A real model benchmark is intentionally opt-in because it starts provider-backed review turns and can incur usage/cost. Run it only on an already verified `READY_FOR_PUBLISH` executor snapshot:

```bash
export WCO_RUN_CODEX_BENCHMARK=1
npm run benchmark:native:context -- \
  --run-id '<task-id>:<task-bundle-sha256>' \
  --artifact-sha '<registered-web-pack-sha256>' \
  --state-dir ./.wco/state \
  --config ./.wco/config.json \
  --reviewer sol \
  --repetitions 2
```

`WCO_RUN_ID`, `WCO_STATE_DIR`, and `WCO_CONFIG` may supply the corresponding defaults. `--artifact-sha` and `--reviewer` remain explicit so the benchmark cannot silently choose a different artifact or authority role.

The harness performs `2 × repetitions` read-only review turns. It alternates order (`baseline → smart`, then `smart → baseline`) to reduce a fixed arm-order bias. Each sample uses a fresh Codex thread.

Before every sample WCO re-attests the exact `READY_FOR_PUBLISH` snapshot. After every model call it re-attests the snapshot again. Any digest/worktree/change-path drift aborts the comparison. The benchmark does not mutate WCO lifecycle receipts.

### Arms

- **baseline:** changed files + accepted Task Bundle authority, with no Smart Context priority hints;
- **smart:** the same exact review instructions and changed files plus the deterministic bounded Smart Context hints.

Both arms keep the same reviewer model and reasoning effort.

### Reported evidence

The JSON report records per sample and per arm:

- provider-reported input tokens;
- provider-reported cached input tokens;
- provider-reported output tokens;
- review elapsed milliseconds;
- verdict;
- reviewed change-set SHA-256;
- exact-digest `APPROVE` success;
- mean and median metrics.

Missing or malformed provider token usage aborts the benchmark instead of fabricating zero usage.

## Interpreting a release-candidate run

For a fixed verified snapshot, Smart Context is acceptable only if review correctness does not regress. The first gate is therefore exact-digest approval behavior, not token reduction.

A useful result should show Smart Context maintaining the baseline exact-digest approval rate while reducing at least one meaningful resource metric (for example provider input tokens or latency) without a material regression in the others. With only a few samples, treat differences as engineering evidence for that snapshot—not a universal statistical claim.

Do not publish percentage cost/token claims from the deterministic selector benchmark. Do not generalize one native A/B run to all repositories, models, or task types.
