
# Permanent project rules

- Downloaded bundles are untrusted input.
- Intake must never execute payloads or validation commands.
- No path may escape a controlled directory.
- Validators return stable structured errors for policy failures.
- Destructive Git, cloud, deployment, and publishing actions require humans.
- Never weaken tests to make a task pass.
- Phase 3 preparation may inspect Git and create only isolated local worktrees;
  it must not execute bundles, validation commands, Codex, commits, pushes,
  GitHub APIs, or browser automation.
- Phase 4 execution is gated by an injected Codex SDK and sandbox; normal CI
  uses fakes and never contacts a model provider or public network.
- Phase 4 must stop before READY_FOR_PUBLISH unless deterministic verification,
  an independent Terra review, and an independent Sol review approve the same
  exact change-set digest.
