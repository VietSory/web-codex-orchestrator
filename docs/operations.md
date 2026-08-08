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

Then routine operation is intentionally short:

```bash
wco doctor
wco status
wco next
wco continue
```

Automation may pass `--config`, `--state-dir`, and `--run-id` explicitly instead of using environment defaults.

## Operational model

`doctor` is a bounded preflight. It verifies local machine/config/runtime prerequisites without starting a model turn.

`status` and `next` are read-oriented control commands. `continue` is the only routine command that advances durable orchestration and it remains bounded by transition, retry, time, token, and authority limits. `pause` prevents new transitions; `resume` does not erase terminal or policy state.

On a crash or retry, WCO first tries to adopt already-completed lower-layer work by re-attesting exact receipts and external identities. It does not assume that a previous terminal message proves the side effect still exists.

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
