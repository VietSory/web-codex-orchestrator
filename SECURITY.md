# Security boundary

Downloaded bundles are untrusted. Phase 4 treats accepted bundles as immutable
metadata, never runs `payload/`, and never copies payload files into a target
repository. Agents cannot select repositories, models, network access,
sandbox mode, credentials, or verifier limits. Validation commands are
structured argument arrays, checked against a trusted executable/environment
policy, and run only through the production Codex sandbox (`codex -c
sandbox_workspace_write.network_access=false sandbox --permission-profile
:workspace --cd <canonical-cwd> -- ...`) or a fake sandbox in tests. The
trusted root-level override prevents `CODEX_HOME` configuration from enabling
workspace network access. The runtime is pinned to the compatible Codex CLI
contract. There is no unsandboxed
fallback. The SDK receives only a minimal trusted environment; provider,
SSH, token, preload, and arbitrary process variables are excluded. Reviews
and verification are invalidated whenever the exact change-set digest changes.

The trusted runtime is `{ "source": "bundled", "codex_home": "..." }`, with
`codex_home` optional and absolute when configured. WCO resolves the pinned
`@openai/codex@0.145.0` package from its own installation and never uses a
global `codex` executable, environment-selected executable, or a
bundle-supplied path.
The accepted bundle is read by the orchestrator and
bounded content is placed in prompts; it is not an additional writable SDK
root. Deterministic verifier failures are redacted and bounded before being
stored in receipts, artifacts, or Terra correction prompts.

## Phase 7 Web review boundary

Phase 7 treats the canonical Phase 3 run receipt, Phase 6 Result Bundle handoff,
Web verdict, persisted review state, and fresh GitHub response as explicit
security boundaries. The complete authority paths under `runs/` and
`handoff/runs/` must remain inside the configured state root with no symbolic
link in any ancestor. The exact Phase 6 receipt bytes are allocation-bounded,
read through one stable file handle, hash-bound, parsed, and validated from the
same buffer before the independently verified Result Bundle is trusted.

The Web verdict is a regular non-symlink file with an allocation-safe 1 MiB
cap. WCO allocates only the size attested by the opened file handle, reads
exactly those bytes, probes one additional byte for growth, and verifies stable
identity, size, and file metadata before canonicalization. The Result Bundle is
independently verified, then only bounded, hash-bound review/spec entries are
selectively loaded. The verdict is bound to the exact Task Bundle run, Result
Bundle, manifest, spec set, published commit, Draft Pull Request, and reviewed
entry set.

Phase 7 review state is stored only below the configured state directory.
Lifecycle directories are created one component at a time and existing
symbolic-link ancestors or non-directories are rejected. Persisted receipt,
verdict, decision, and revision files are regular non-symlink files, have a
hard 2 MiB allocation cap, and must keep stable file identity, size, and
metadata across reads. Immutable artifacts use create-only exact
compare-and-adopt semantics. Receipt diagnostics are bounded so repeated
failures cannot grow persisted state without limit.

A per-round lock is owned by PID plus a random nonce. Existing locks are never
automatically stolen or removed, including apparently stale or malformed
locks, because path-based stale-lock reclamation has a replacement race.
Operator recovery is deliberately fail-closed and must verify that no live
owner exists before manual cleanup.

Every terminal decision is authorized by fresh, read-only GitHub state. The
Pull Request must still be open, unmerged, and Draft, with exact head/base
repository identities, branches, head SHA, and base SHA. Exact terminal retries
re-run this attestation rather than reusing stale approval authority. Production
GitHub access is pinned to `https://api.github.com`, has a 10-second request
timeout, and reads response bodies incrementally with a hard 1 MiB cap.
Authentication failures, transient network/service failures, and missing or
invalid repository identity are classified separately, but all fail closed.
Phase 7 never commits, pushes, marks a PR Ready, modifies a PR, or merges. An
`APPROVED` result applies only to its exact attested head; later PR/head drift
requires fresh validation before a human merge action.

## Phase 8 same-PR revision boundary

Phase 8 is not a new authority source. It may consume only the canonical
`REVISION_REQUESTED` terminal produced by Phase 7. Before agent work begins it
reconstructs that sealed request and its exact preceding Result Bundle/verdict,
resolves the canonical Phase 3 trusted run context, and requires the recorded
worktree and accepted Task Bundle to remain canonical real directories below
the configured WCO state root. It then re-attests the accepted Task Bundle
against the `accepted_bundle_tree_sha256` already sealed in the preceding
independently verified Result Bundle. Recomputing `checksums.json` after
modifying accepted bundle files does not create new authority: the tree hash
must still equal the previously sealed value.

The mutable Phase 8 receipt is a progress checkpoint, not an authority source.
On resume, all externally derivable identity fields are rebound to canonical
Phase 3/7/config state, including run/round, revision request and history hashes,
PR number, branch/base, worktree path, and configured implementer/Terra/Sol
models and reasoning effort. Worktree changes still have to reproduce the exact
approved path set and file snapshot, and the final change-set digest must be the
same digest independently accepted by deterministic verification, Terra, and
Sol before publication authority is persisted.

Git network operations are fail-closed against remote replacement and mutable
Git URL rewriting. The current `git remote get-url` value is sanitized and must
equal the remote URL sealed at the trusted revision boundary, but that remote
name is used only as a configuration attestation. Every Phase 8 network
`ls-remote` executes from a newly created clean bare Git repository instead of
the product worktree. A push uses a separate clean bare sender whose local
config is empty and whose object database sees the already-created revision
commit read-only through Git `objects/info/alternates`. The production
`GitRunner` also disables system Git config and points global config at the
trusted empty revision-runtime config. Consequently worktree-local
`url.*.insteadOf` and `url.*.pushInsteadOf` rules are not loaded by the network
transport and cannot redirect credentials or publication after the sealed URL
has been selected. Each clean transport directory is removed after the network
operation.

Immediately before an actual push, Phase 8 also rechecks the accepted Task
Bundle and freshly attests that the same GitHub Pull Request remains open,
unmerged and Draft with the exact previous head/base identities. Phase 8 then
permits only a normal push of one commit whose sole parent is the previous PR
head. It has no force-push, amend, rebase, branch-deletion, create-PR,
mark-ready, or merge path.

Revision Result Bundle v1.2 is append-only review evidence. Review round 1 may
consume only the initial Phase 6 v1.1 bundle; review rounds 2..4 may consume only
Phase 8 v1.2 bundles for revision rounds 1..3 respectively. Phase 7 checks the
v1.2 previous Result Bundle archive/receipt, previous Web verdict, revision
request, previous published commit/head, spec set, and PR number against the
exact previous terminal review before accepting a new verdict. Missing or
mismatched chain elements fail closed and there is no fallback to an older
bundle.

Phase 8 archive-visible timestamps are retry-stable. If a verified revision
Result Bundle already reached `READY_FOR_WEB_REVIEW` but the parent revision
checkpoint was not yet advanced to `RESULT_READY`, a retry independently
re-verifies and adopts the exact existing archive instead of rebuilding it with
new bytes. This keeps crash recovery idempotent without overwriting sealed
review evidence.

## Phase 9 Web Authority Protocol boundary

Phase 9 treats a Web-authored implementation archive as **untrusted until
registered**. A valid ZIP is not authority merely because its internal
checksums are self-consistent. Registration independently binds it to the
canonical Phase 3 run/configuration, accepted Task Bundle, clean worktree, base
commit/tree, actual Git inventory and exact operation preimages.

Web pack intake is bounded before authority creation: the archive, entry count,
per-entry bytes, total uncompressed bytes, operation count and source-receipt
count all have hard limits. ZIP comments, encryption, unsupported compression,
non-regular/directory entries, absolute/traversal/backslash paths, Unicode/case
collisions and `.git/**` operation paths fail closed. Each non-checksum entry is
covered exactly once by `checksums.json`; payload bytes and frozen lock/source
artifacts are SHA-256 bound from `implementation-pack.json`.

Repository claims are checked against Git rather than trusted from Web. WCO
requires the canonical worktree to remain clean at the locked base commit,
recomputes the base tree, parses the complete `git ls-tree -rz -l --full-tree`
inventory, and requires the Web inventory to match entry-for-entry. Read
coverage may reference only the exact blob object IDs in that verified
inventory, and project-map paths must also exist uniquely in the inventory.
Source receipt enums/fields and lock documents are runtime closed-world in
addition to their JSON schemas.

The accepted Task Bundle spec set is recomputed from bounded, stable,
non-symlink file reads. Operation preimages are read through the same
allocation-safe pattern: size is attested before allocation, `O_NOFOLLOW` is
used where supported, an exact-sized buffer is read, a one-byte growth probe is
performed, and file identity/size are rechecked through both handle and path.
Create operations require absence/null preimage; replace/delete require the
exact SHA-256 of existing bytes.

Registered artifacts are content-addressed below
`authority/runs/<task>/<task-bundle-sha>/artifacts/<archive-sha>/`. Registry
ancestors must remain real directories inside the state root. The source ZIP is
copied to a create-only immutable path and hash/size checked; WCO then parses
and semantic-validates **that immutable registry copy again** before creating
`registration.json`. Re-registering the same exact pack adopts the first valid
registration and preserves its original timestamp. Different bytes/authority
at an existing immutable path are integrity conflicts. Status reads use bounded
stable registration reads and independently re-hash the registered archive.

Phase 9 deliberately has no product-worktree mutation, agent invocation,
commit, push, PR creation/update, mark-ready or merge path. Phase 10 may apply
code only by re-consuming a valid Phase 9 registration and matching archive;
chat prose, a loose patch, an mtime-selected “latest” file, or an unregistered
archive never creates implementation authority.
