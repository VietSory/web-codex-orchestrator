
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
