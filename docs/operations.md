# Operations and Packaging

## Configuration

Start from `examples/config.example.json`. Keep real configuration and state outside version control; `.wco/` is ignored by default.

A convenient source-checkout layout is:

```text
.wco/
  config.json
  state/
```

Set explicit defaults once per shell/session:

```bash
export WCO_CONFIG="$PWD/.wco/config.json"
export WCO_STATE_DIR="$PWD/.wco/state"
export WCO_RUN_ID='<task-id>:<task-bundle-sha256>'
```

Then normal operation is intentionally short:

```bash
wco doctor
wco preview ./task-bundle.zip
wco run ./task-bundle.zip
wco status
```

Automation may pass `--config`, `--state-dir`, and `--run-id` explicitly instead of using environment defaults. Lower-level `next` and `continue` remain available for automation and debugging, but they are not the primary user workflow.

## Operational model

`doctor` is a bounded preflight. It verifies local machine/config/runtime prerequisites without starting a model turn. In addition to Node, Git, trusted configuration, credentials, pinned Codex runtime and authentication, it performs a bounded Codex verification-sandbox smoke test with network disabled. A failed sandbox check is a failed preflight, not a reason to fall back to unrestricted host execution.

`preview` securely intakes and validates a Task Bundle and reports repository target, scope, validation commands, delivery policy, and human-approval boundaries. It may write WCO intake state, but it does not create a worktree, modify repository files, or request network access. Preview re-reads accepted JSON through bounded stable non-symlink reads rather than trusting a pathname that was checked earlier.

`run` prepares the exact run and advances the durable controller until an explicit external input, human, retry, or terminal boundary. `status` and `next` are read-oriented. `pause` prevents new transitions. `resume` only clears an explicit operator pause; it does not itself execute recovery or another transition. Recovery/re-attestation happens before the next side effect attempted by `run` or lower-level `continue`.

On a crash or retry, WCO first tries to adopt already-completed lower-layer work by re-attesting exact receipts and external identities. It does not assume that a previous terminal message proves the side effect still exists. If a persisted checkpoint spans a provider-backed model call whose outcome was never sealed, WCO fails closed instead of replaying that ambiguous call automatically.

## Model budget semantics

WCO distinguishes limits it can enforce before a provider-backed model call from usage it can only measure after that call returns.

For the initial executor review path, each Terra/Sol model turn is **reserved and durably persisted before the provider call**. Trusted model-turn and wall-clock limits are checked at that boundary. If the turn/time budget is exhausted, the provider call is not started. A reservation remains consumed after a crash; this deliberately prefers fail-safe over-counting to replaying a model turn beyond the configured limit.

Provider-reported input/output token usage is recorded after each completed review response. If measured token usage reaches or exceeds the configured continuation threshold, WCO records the usage and does not start a later review call. Missing or malformed provider usage fails closed instead of silently treating the turn as zero-cost.

The revision engine also persists its budget counters before model calls. Existing revision checkpoints that could span an unsealed implementer/Terra/Sol call are treated as **ambiguous recovery** on a new invocation and are not replayed automatically. Safe deterministic/publication checkpoints remain adoptable.

**Token limits are not described as a strict current-call provider billing cap.** The pinned Codex TypeScript SDK does not give WCO a reliable per-call output-token ceiling to enforce that stronger guarantee. WCO therefore reports what it can prove: hard pre-call turn/time gating plus measured token continuation thresholds.

`wco status` reports WCO-owned durable counters. External browser/Chat research is outside this runtime and is not silently included in those counters.

## Smart Context

Initial Terra/Sol review uses a deterministic bounded context selector derived from the registered Web pack's already-bound `project-map.json`, `read-coverage.json`, and `prohibited-changes.json` evidence.

The selector:

- always treats changed files as mandatory review targets;
- may prioritize **only paths already present in attested Web read coverage**; project-map metadata may re-rank that set but cannot introduce a new read target by itself;
- prioritizes fully read same-directory files, then partial same-directory files, read-covered same-role files, and broader read coverage;
- excludes registered prohibited paths plus hard-sensitive Git metadata and `.env`-style paths;
- selects at most 24 additional paths and at most 16 KiB of path metadata;
- hashes the selection and records that identity in review evidence;
- treats selected paths as review hints only, never as lifecycle, architecture, acceptance, or authorization authority;
- JSON-quotes repository paths before adding them to prompts so hostile filename characters cannot escape into instructions.

`npm run benchmark:context` is a repeatable offline selector benchmark. It measures selector overhead and context-path byte reduction only. It deliberately does **not** claim provider token savings, latency savings, model quality, cost reduction, or task-success improvements without an actual model-backed experiment.

## State and backup policy

WCO state contains security-relevant receipts and recovery evidence. Treat the state directory as application data:

- do not edit it manually while a run is active;
- do not synchronize it concurrently through tools that may replace files or symlinks;
- back it up together with the corresponding repository state if long-running missions must survive machine loss;
- do not copy secrets into task bundles, verdicts, or diagnostics.

Diagnostic journals are bounded per record, but long-lived forensic logs may still need an operator retention/archive policy.

## Native installation versus Docker

### Primary recommendation: native CLI

Use native Node/Git integration for the first stable WCO releases. This is the least surprising deployment model because WCO intentionally needs access to:

- host Git repositories and worktrees;
- local Git identity and credential helpers;
- Codex authentication/runtime state;
- GitHub credentials supplied by the operator environment;
- optional browser/bridge tools that may live outside a container.

Containerizing those dependencies would require several bind mounts, credential forwarding, UID/GID handling, and possibly host sockets. That can make a one-line `docker run` look simple while moving complexity into opaque mount/auth failures.

### Where Docker helps

A Docker image or devcontainer can be valuable for reproducible development, deterministic test dependencies, and CI experiments. It should be treated as an optional development environment until native release behavior is stable.

If WCO later gains a remote worker mode with a narrow repository/artifact API instead of direct host integration, a container becomes a much stronger runtime deployment option.

## Release path

The recommended sequence is:

1. **Now:** source checkout for contributors and technical evaluators.
2. **Release candidate:** `npm pack` artifact attached to a GitHub Release, with SHA-256 checksum and provenance/attestation.
3. **Stable CLI:** optionally publish the same package to npm after supported native environments pass compatibility checks.
4. **Optional container:** publish a separate development/worker image only when its host-integration contract is explicit.
5. **Automatic updater:** only then consider a TUF-style update metadata design to protect update and rollback behavior.

The package remains `private: true` during pre-release so an accidental `npm publish` cannot create an unsupported public release. `npm run pack:check` still verifies which files would be shipped.

## Release integrity roadmap

For public releases, add the following without weakening current exact-head CI:

- SBOM generation for runtime dependencies;
- SLSA-compatible build provenance or GitHub artifact attestation;
- checksums for downloadable archives;
- documented supported Node/OS matrix;
- dependency and CodeQL/security scanning with reviewed findings;
- signed/tag-protected release workflow where practical.
