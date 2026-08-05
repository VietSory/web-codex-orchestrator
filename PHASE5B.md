# Phase 5B: Draft Pull Request Creation

This document outlines the architecture and behavior of the Phase 5B process, which deterministically creates a GitHub Draft Pull Request.

## Scope and Non-Goals
Phase 5B is strictly limited to adopting an existing same-repository Draft Pull Request, or creating a new Draft Pull Request if one does not exist.
**Non-goals:**
- Updating existing Pull Requests (title, body, state, base).
- Changing Pull Request review status (Ready for Review, Merge).
- Forks, SSH, GitHub Enterprise, or native Windows git endpoints (these are explicitly deferred).
- Fetching and tracking remote branches automatically.

## Configuration and Token Variable
To enable Phase 5B, configure the `github_pull_request` block in your config:
```json
"github_pull_request": {
  "provider": "github.com",
  "authentication": {
    "mode": "https_token",
    "token_environment_key": "WCO_GITHUB_TOKEN"
  }
}
```
**Permissions:** The fine-grained personal access token provided in the environment variable (e.g., `WCO_GITHUB_TOKEN`) must have **Pull requests: write** repository permission.

## Fixed GitHub API Details
The client communicates strictly with:
- **Origin:** `https://api.github.com`
- **Version:** `2026-03-10`

## Deterministic Request Content
The generated Pull Request content is fully deterministic and avoids leaking local runtime artifacts:
- **Title:** `WCO delivery: <task_id>`
- **Body:** Contains only execution metadata (Run ID, Task ID, Repository, Base/Delivery branch names, published commit SHA, and change set SHA256).

## State Machine and Delivery
The state machine implements a strict at-most-one mutating request policy (`POST`). The model guarantees:
- **At-most-one ambiguous POST:** The system will never attempt to execute more than one `POST` to create a pull request if the response was ambiguous (e.g., a timeout or a 5xx).
- **Exact recovery criteria:** 
  An existing Pull Request will only be adopted if:
  - It is for the exact same repository.
  - The head branch and base branch match exactly.
  - The head commit SHA exactly matches the expected Phase 5A `PUSHED` commit.
  - It is in `open` state, `draft` mode, and not merged.
  - It is the only candidate matching the head branch.
- **Conflict Behavior:** If more than one candidate exists for the branch, or if a single candidate has mismatched properties (wrong base, wrong SHA, merged, not draft, etc.), the system safely transitions to `CONFLICT` and aborts.

## Receipt
Phase 5B produces a strict receipt that logs the execution timeline, request/body SHA256 digests, and discovered identities.
- **Path:** `<executionDirectory>/publish/github-draft-pr.json`
- **Schema:** Contains the explicit transition fields `state`, `run_id`, observed timestamps, and GitHub pull request URL.

## CLI Usage and Exit Codes
Command:
```bash
wco create-draft-pr --run-id <run-id> --state-dir <directory> --config <config.json> [--json]
```
Exit Codes:
- `0`: Execution successfully converged to the `OPEN` state.
- `1`: Conflict, policy, configuration, or identity mismatch occurred (e.g., `CONFLICT`).
- `2`: Invalid CLI usage.
- `3`: API, network, rate-limit, or `CREATE_UNCERTAIN` state.
