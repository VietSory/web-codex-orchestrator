# Web Authority Contract v2

## Roles

- **ChatGPT Web / Web Authority:** research, repository understanding, architecture, acceptance criteria, exact implementation authoring and final review.
- **WCO:** artifact authority, state machine, policy enforcement, deterministic evidence and recovery.
- **Local Codex agent:** constrained executor/reviewer under WCO policy; never architecture authority.
- **MCP / repository inspection tools:** primarily read/interaction surfaces; they do not create implementation authority by themselves.
- **User:** owns merge and explicit human-decision gates.

## Authority order

When inputs disagree, authority is resolved in this order:

1. canonical trusted local configuration and canonical Phase 3 run receipt;
2. accepted Task Bundle identified by `run_id`;
3. registered, exact-sha Web implementation pack and its frozen locks;
4. deterministic verifier/evidence for the exact resulting snapshot;
5. registered Web review response/verdict for that exact artifact/snapshot;
6. mutable caches, indexes, UI state and chat prose are non-authoritative.

A lower item may not redefine a higher item.

## Web preparation requirements

Before emitting an implementation pack Web must establish and record:

1. exact repository base commit and tree;
2. repository inventory for that tree;
3. explicit read coverage identifying the Git object IDs actually inspected;
4. a reusable project map bound to the tree;
5. research/source receipts with content hashes;
6. architecture lock;
7. acceptance lock;
8. prohibited-change registry;
9. exact intended file operations;
10. exact preimage SHA-256 for each existing operation target;
11. payload SHA-256 for every created/replaced file.

## Closed-world implementation pack

Anything not in `operations.json` is outside the implementation authority of that pack.

Phase 10 must not interpret natural-language prose as permission to edit an unlisted file. If the exact operation cannot be applied because a preimage/snapshot is stale, the correct action is `ESCALATE_TO_WEB`, not redesign.

## Snapshot invalidation

A pack is stale when any of these no longer match:

- canonical run/task bundle identity;
- repository ID/base branch/base commit/tree;
- accepted Task Bundle spec set;
- exact operation preimages;
- registered archive SHA-256.

A stale pack cannot be repaired locally by editing its manifest, checksums, preimages or payload. Web must issue a new registered artifact.

## Source receipts

Source receipts are evidence about what informed Web. They do not supersede repository/task authority. Each receipt records a content SHA-256 in addition to a locator so later audits can distinguish “same URL, changed content”.

## Project map and read coverage

The project map is a performance/navigation artifact, not an implementation permission list. Read coverage is an audit artifact, not proof that Web understood a file. WCO validates both against the exact repository tree; later maintainers still judge whether coverage was sufficient for the change.

## Response envelope

A Web response envelope binds its decision to an exact prior artifact SHA-256 and payload SHA-256. A response envelope never grants merge authority: merge remains a user decision.

## Performance/token requirements

Protocol v2 is deliberately snapshot-oriented:

- immutable inventory/project-map/source artifacts are reusable by tree/hash;
- dynamic task/operation information is kept separate from stable context;
- later agent turns should reference artifact hashes and retrieve only relevant chunks instead of replaying the entire repository/history;
- caches are hints only and must be invalidated by tree/spec hash changes;
- concurrency is bounded and backpressured rather than spawning one hot browser/agent session per queued task.

## Explicitly forbidden authority creation

WCO must fail closed when asked to execute from:

- unregistered patches or replacement files;
- “latest file” or mtime selection;
- chat-only approval;
- a registry record whose archive no longer hashes correctly;
- a pack whose manifest self-consistency passes but canonical run/Git/spec/preimage attestation fails.
