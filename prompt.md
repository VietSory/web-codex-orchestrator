Implement Phase 4 of:

https://github.com/VietSory/web-codex-orchestrator

Create branch:

codex/phase-4-agent-verifier-review

Base the branch on the latest main branch after Phase 3 was merged.

Create a Draft Pull Request when complete.

Do not merge the Pull Request.
Do not push to main.
Do not create releases or deployments.

TITLE

Phase 4 — Terra Implementation, Deterministic Verification,
Mandatory Terra Internal Review, and Independent Sol Final Review

======================================================================
1. CURRENT STATE
======================================================================

The repository currently supports:

    wco validate <task-bundle-directory>

    wco intake <task-bundle.zip>
      --state-dir <directory>
      [--json]

    wco prepare <task-bundle.zip>
      --state-dir <directory>
      --config <config.json>
      [--json]

    wco scan
      --inbox <directory>
      --state-dir <directory>
      --config <config.json>
      [--json]

    wco watch
      --inbox <directory>
      --state-dir <directory>
      --config <config.json>
      [--jsonl]

Phase 3 ends at:

    READY_FOR_CODEX

At READY_FOR_CODEX:

- the task ZIP has passed secure intake;
- the accepted bundle is outside the target repository;
- the local repository came from a trusted registry;
- the remote URL was verified;
- the exact base commit was verified;
- an isolated Git branch was created;
- an isolated Git worktree was created;
- the worktree is clean;
- no payload was executed;
- no Codex model was started;
- no validation command was executed;
- no commit was created;
- no branch was pushed;
- no Pull Request was created.

======================================================================
2. OBJECTIVE
======================================================================

Implement this controlled execution pipeline:

    READY_FOR_CODEX
        ↓
    CODEX_PREFLIGHT
        ↓
    TERRA_ASSESSING
        ├── REPLAN_REQUIRED
        ├── HUMAN_REQUIRED
        ├── POLICY_BLOCKED
        └── COMPATIBLE
               ↓
    TERRA_IMPLEMENTING
               ↓
    POLICY_CHECKING
        ├── violation → POLICY_BLOCKED
        └── pass
               ↓
    VERIFYING
        ├── fail → TERRA_FIXING
        │             ↓
        │         POLICY_CHECKING
        │             ↓
        │         VERIFYING
        └── pass
               ↓
    TERRA_REVIEWING
        ├── REVISE → TERRA_FIXING
        │              ↓
        │          POLICY_CHECKING
        │              ↓
        │          VERIFYING
        │              ↓
        │          fresh TERRA_REVIEWING
        ├── REPLAN → WEB_REVIEW_REQUIRED
        ├── ESCALATE → HUMAN_REQUIRED
        └── APPROVE
               ↓
    SOL_REVIEWING
        ├── REVISE → TERRA_FIXING
        │              ↓
        │          POLICY_CHECKING
        │              ↓
        │          VERIFYING
        │              ↓
        │          fresh TERRA_REVIEWING
        │              ↓
        │          fresh SOL_REVIEWING
        ├── REPLAN → WEB_REVIEW_REQUIRED
        ├── ESCALATE → HUMAN_REQUIRED
        └── APPROVE
               ↓
    READY_FOR_PUBLISH

Phase 4 succeeds only when it reaches:

    READY_FOR_PUBLISH

======================================================================
3. MANDATORY REVIEW ORDER
======================================================================

The mandatory order is:

    Terra Implementer
        ↓
    Deterministic Verifier
        ↓
    Independent Terra Internal Reviewer
        ↓
    Independent Sol Final Reviewer

The Sol reviewer must never be started unless all of these are true:

1. every required deterministic verification command passed;
2. path and change policies passed;
3. the independent Terra reviewer returned APPROVE;
4. every required acceptance criterion is PASS;
5. the Terra review has zero blocking findings;
6. the Terra review has zero scope violations;
7. the Terra review has zero unverified required acceptance criteria;
8. the Terra verdict references the current exact change-set digest;
9. the worktree has not changed after Terra review;
10. the accepted task bundle has not changed.

A Terra implementation result is not sufficient to invoke Sol.

A verifier PASS result is not sufficient to invoke Sol.

Sol is the final independent review gate only after Terra has completed
its own independent review gate.

======================================================================
4. NON-GOALS
======================================================================

Phase 4 must not:

- create Git commits;
- push Git branches;
- push to main, master, develop, or production;
- create or update a Pull Request;
- call GitHub REST or GraphQL APIs;
- invoke GitHub CLI;
- merge branches;
- delete remote branches;
- force push;
- automate a browser;
- contact ChatGPT Web;
- upload result ZIP files;
- deploy;
- publish packages;
- access production infrastructure;
- access cloud credentials;
- access SSH keys;
- use danger-full-access;
- silently fall back to unsandboxed execution;
- enable model network access;
- enable web search;
- automatically execute downloaded apply scripts.

Phase 5 will implement:

    READY_FOR_PUBLISH
    → commit
    → push
    → Draft Pull Request
    → READY_FOR_WEB_REVIEW

======================================================================
5. AGENT ROLES
======================================================================

5.1 Terra Implementer

Trusted local configuration:

    model: gpt-5.6-terra
    reasoning effort: high
    sandbox: workspace-write
    network access: false
    web search: disabled
    approval policy: never

Responsibilities:

- assess the task bundle against the real repository;
- implement the accepted request;
- add or update tests;
- fix deterministic verifier failures;
- fix validated Terra reviewer findings;
- fix validated Sol reviewer findings;
- stay inside allowed paths;
- never commit;
- never push;
- never change branch;
- never weaken tests or validation;
- never modify bundle contract files;
- never access credentials;
- never make external network requests.

The implementer must not decide that Phase 4 is complete.

5.2 Terra Internal Reviewer

Trusted local configuration:

    model: gpt-5.6-terra
    reasoning effort: high
    sandbox: read-only
    network access: false
    web search: disabled
    approval policy: never

The Terra reviewer must:

- use a new thread separate from the implementer thread;
- review only after deterministic verification passes;
- review the actual diff and actual change set;
- review each required acceptance criterion;
- find correctness, regression, scope, security, and test-quality issues;
- check whether tests merely make the implementation appear correct;
- verify that test coverage matches expected behavior;
- not modify repository files;
- not reuse the implementer's thread;
- not receive hidden reasoning or full implementer transcripts.

Only Terra reviewer APPROVE permits Sol review.

5.3 Sol Final Reviewer

Trusted local configuration:

    model: gpt-5.6-sol
    reasoning effort: high
    sandbox: read-only
    network access: false
    web search: disabled
    approval policy: never

The Sol reviewer must:

- use a new thread separate from all Terra threads;
- independently evaluate the implementation;
- not trust the Terra review conclusion without evidence;
- verify correctness, security, architecture, regression risk, scope,
  maintainability, and acceptance coverage;
- not modify repository files;
- review the exact digest approved by Terra.

Sol APPROVE is required for READY_FOR_PUBLISH.

======================================================================
6. AGENT CLIENT ABSTRACTION
======================================================================

Use the current supported public Codex SDK.

Do not use undocumented SDK internals.

Place the SDK behind an AgentClient abstraction.

Required capabilities:

- start a new thread;
- resume an existing implementer thread;
- execute a turn;
- receive streamed public events when available;
- request structured output;
- support AbortSignal;
- return thread ID;
- return final structured response;
- return available usage metadata;
- return sanitized runtime errors.

Tests must use FakeAgentClient.

Normal CI must not:

- authenticate with Codex;
- contact OpenAI;
- consume model quota;
- require a real Codex installation.

Persist thread IDs immediately after creation.

Do not persist model chain-of-thought.

Persist only:

- thread ID;
- agent role;
- event type;
- timestamps;
- final structured response;
- usage metadata;
- sanitized command/tool summaries;
- sanitized errors.

Do not log full prompts by default.

======================================================================
7. SCHEMA VERSION 1.3
======================================================================

Continue accepting schema versions 1.0, 1.1, 1.2, and 1.3 for secure
validation and intake.

Continue allowing schema versions 1.2 and 1.3 for Phase 3 preparation.

Only schema version 1.3 is executable by Phase 4.

Executing an older schema returns:

    EXECUTION_SCHEMA_UPGRADE_REQUIRED

Schema 1.3 keeps the Phase 3 repository, delivery, Git policy, path, and
limit contracts.

Replace validation command strings with executable and argv fields.

Example validation.json:

{
  "schema_version": "1.3",
  "commands": [
    {
      "id": "typecheck",
      "executable": "npm",
      "args": ["run", "typecheck"],
      "cwd": ".",
      "environment": {
        "CI": "true"
      },
      "required": true,
      "timeout_seconds": 180,
      "maximum_output_bytes": 1048576
    },
    {
      "id": "test",
      "executable": "npm",
      "args": ["test"],
      "cwd": ".",
      "environment": {
        "CI": "true"
      },
      "required": true,
      "timeout_seconds": 600,
      "maximum_output_bytes": 2097152
    },
    {
      "id": "build",
      "executable": "npm",
      "args": ["run", "build"],
      "cwd": ".",
      "environment": {
        "CI": "true"
      },
      "required": true,
      "timeout_seconds": 300,
      "maximum_output_bytes": 1048576
    }
  ]
}

======================================================================
8. VALIDATION COMMAND CONTRACT
======================================================================

For schema 1.3:

- executable and args must be separate;
- shell command strings are not accepted;
- executable must be a simple executable name;
- executable must not be an absolute path;
- executable must not contain slash;
- executable must not contain backslash;
- executable must not contain whitespace;
- executable must not contain NUL;
- executable must not contain shell operators;
- args must be an array of strings;
- args must not contain NUL;
- cwd must be a safe relative path;
- cwd must remain inside the worktree;
- cwd must exist;
- cwd must be a real directory;
- cwd must not be a symlink;
- required must be boolean;
- timeout_seconds must be a positive integer;
- maximum_output_bytes must be within trusted limits;
- environment keys must be explicitly allowlisted;
- environment values must be bounded strings;
- no shell may be invoked;
- shell: true is forbidden;
- fallback to sh, bash, cmd, PowerShell, or another shell is forbidden.

The bundle must not override:

- PATH
- HOME
- USERPROFILE
- SHELL
- COMSPEC
- CODEX_HOME
- NODE_OPTIONS
- PYTHONPATH
- LD_PRELOAD
- DYLD_*
- GIT_CONFIG*
- SSH_*
- AWS_*
- AZURE_*
- GOOGLE_*
- GITHUB_*
- OPENAI_*
- credential-related variables.

======================================================================
9. TRUSTED LOCAL CONFIGURATION
======================================================================

Extend trusted configuration with:

{
  "agents": {
    "implementer": {
      "model": "gpt-5.6-terra",
      "reasoning_effort": "high"
    },

    "internal_reviewer": {
      "model": "gpt-5.6-terra",
      "reasoning_effort": "high"
    },

    "final_reviewer": {
      "model": "gpt-5.6-sol",
      "reasoning_effort": "high"
    },

    "limits": {
      "maximum_implementation_iterations": 8,
      "maximum_internal_review_rounds": 4,
      "maximum_sol_review_rounds": 3,
      "maximum_total_agent_turns": 18,
      "maximum_turn_seconds": 1800,
      "maximum_total_seconds": 7200,
      "maximum_total_input_tokens": 2000000,
      "maximum_total_output_tokens": 300000
    }
  },

  "verification": {
    "allowed_executables": [
      "node",
      "npm",
      "python",
      "python3",
      "go",
      "cargo",
      "dotnet",
      "git"
    ],

    "allowed_environment_keys": [
      "CI",
      "NODE_ENV",
      "CGO_ENABLED",
      "RUST_BACKTRACE",
      "DOTNET_NOLOGO"
    ],

    "maximum_command_seconds": 1800,
    "maximum_output_bytes": 4194304,

    "allowed_generated_paths": [
      "coverage/**",
      "dist/**",
      "build/**",
      "target/**",
      ".pytest_cache/**"
    ]
  }
}

Rules:

- reject unknown fields;
- model selection comes only from trusted local config;
- the downloaded bundle cannot choose models;
- the downloaded bundle cannot increase reasoning effort;
- the downloaded bundle cannot enable networking;
- the downloaded bundle cannot weaken sandbox mode;
- the downloaded bundle cannot change approval policy;
- the downloaded bundle cannot increase trusted limits;
- effective limits use the lower trusted value;
- danger-full-access is forbidden;
- no credentials may be stored in committed config examples;
- examples/config.example.json must use placeholder values only.

======================================================================
10. CODEX RUNTIME PREFLIGHT
======================================================================

Before starting a real agent:

1. verify run state is READY_FOR_CODEX or a valid resumable Phase 4 state;
2. verify worktree exists;
3. verify worktree path is canonical;
4. verify worktree remains below state-dir/worktrees;
5. verify current branch equals the Phase 3 branch;
6. verify HEAD equals the Phase 3 base commit;
7. verify no commit was added;
8. verify accepted bundle path remains unchanged;
9. verify accepted bundle digest;
10. verify the Codex runtime can be resolved;
11. verify authentication is available without printing credentials;
12. verify the required platform sandbox is available;
13. verify network is disabled;
14. verify live web search is disabled;
15. verify cached web search is disabled;
16. verify no additional writable root is granted;
17. verify no execution lock already exists.

If the required sandbox cannot be enforced:

    CODEX_SANDBOX_UNAVAILABLE

Never silently run Codex without sandbox protection.

======================================================================
11. ACCEPTED BUNDLE IMMUTABILITY
======================================================================

The accepted task bundle remains outside the Git worktree.

Do not automatically copy payload files into the worktree.

Do not grant the accepted bundle as an additional writable directory.

Before and after every agent turn:

- verify accepted bundle tree digest;
- detect created files;
- detect removed files;
- detect modified files;
- detect path changes.

Any mutation returns:

    BUNDLE_MUTATED

Terra may read payload content as an untrusted proposal.

For Phase 4 MVP:

- apply-script payload execution remains disabled;
- patch payload auto-application remains disabled;
- payload files are never executed merely because README says to run them;
- Terra may manually reimplement the proposed changes after reviewing them.

======================================================================
12. TERRA ASSESSMENT TURN
======================================================================

The first Terra implementer turn is assessment-only.

Terra must:

1. read AGENTS.md;
2. read relevant accepted bundle files;
3. inspect the actual repository;
4. compare repository reality with:
   - REQUEST.md
   - PLAN.md
   - RULES.md
   - acceptance.json
   - test-matrix.json
   - validation.json
   - risk-policy.json;
5. inspect payload source without executing it;
6. identify contradictions;
7. identify missing prerequisites;
8. identify unsafe requests;
9. return structured assessment;
10. make no repository changes.

Assessment output:

{
  "status": "COMPATIBLE | REPLAN_REQUIRED | HUMAN_REQUIRED | BLOCKED",
  "summary": "string",
  "repository_observations": ["string"],
  "bundle_conflicts": [
    {
      "id": "string",
      "severity": "low | medium | high | critical",
      "description": "string",
      "affected_contract": "string"
    }
  ],
  "missing_prerequisites": ["string"],
  "human_action": null
}

For HUMAN_REQUIRED:

{
  "category": "credential | network | destructive | production |
               ambiguous_requirement | paid_resource | other",
  "description": "string",
  "requested_capability": "string"
}

After assessment verify:

- HEAD unchanged;
- branch unchanged;
- Git status unchanged;
- filesystem snapshot unchanged;
- accepted bundle unchanged.

If assessment changes the worktree:

    AGENT_ASSESSMENT_MUTATED_WORKTREE

Stop execution.

======================================================================
13. TERRA IMPLEMENTATION TURN
======================================================================

If assessment is COMPATIBLE, resume the same Terra implementer thread.

Terra must:

- implement only the accepted request;
- follow repository conventions;
- stay inside allowed paths;
- add or update appropriate tests;
- never modify acceptance criteria;
- never modify the test matrix;
- never modify validation contracts;
- never modify risk policy;
- never weaken an existing test;
- never remove validation to obtain a pass;
- never commit;
- never push;
- never switch branch;
- never use network;
- never access credentials;
- stop when ready for deterministic verification.

Implementation output:

{
  "status": "READY_FOR_VERIFICATION | REPLAN_REQUIRED |
             HUMAN_REQUIRED | BLOCKED",

  "summary": "string",

  "changed_files_claimed": [
    "relative/path"
  ],

  "acceptance_evidence": [
    {
      "acceptance_id": "AC-001",
      "status": "implemented | partially_implemented | blocked",
      "evidence": [
        "relative/path:symbol"
      ],
      "notes": "string"
    }
  ],

  "tests_added_or_changed": [
    "relative/path"
  ],

  "unresolved_issues": [
    "string"
  ],

  "human_action": null
}

Do not trust changed_files_claimed.

The orchestrator must derive the real changed-file set independently.

======================================================================
14. MODEL OUTPUT VALIDATION
======================================================================

Treat all model output as untrusted.

For every machine-consumed response:

- parse JSON;
- validate exact schema;
- reject unknown fields;
- enforce enum values;
- bound string length;
- bound array length;
- validate every returned path;
- ensure paths are relative;
- ensure paths remain below the worktree;
- verify cited files exist;
- verify cited line ranges where supplied;
- never execute a model-suggested command;
- never treat prose as authorization.

Malformed output returns:

    AGENT_OUTPUT_INVALID

Allow at most one formatting/schema repair turn per response.

Do not allow unlimited format repair loops.

======================================================================
15. CHANGE AND PATH POLICY
======================================================================

After every Terra implementation or fix turn and before every verifier or
reviewer:

1. verify HEAD still equals base commit;
2. verify current branch has not changed;
3. derive tracked changes;
4. derive deleted files;
5. derive renamed files;
6. derive untracked files;
7. resolve every path below the worktree;
8. reject path traversal;
9. reject introduced symlinks;
10. reject introduced special files;
11. reject changes to .git;
12. reject Git metadata changes;
13. reject repository ref changes;
14. reject submodule changes;
15. reject .gitmodules changes;
16. reject files outside allowed_paths;
17. reject files matching forbidden_paths;
18. enforce max_changed_files;
19. enforce max_diff_lines;
20. detect oversized files;
21. reject binary changes unless trusted config explicitly permits them;
22. calculate canonical change-set SHA-256.

Required errors:

    AGENT_COMMITTED_CHANGES
    AGENT_CHANGED_BRANCH
    PATH_POLICY_VIOLATION
    FORBIDDEN_PATH_CHANGED
    CHANGE_LIMIT_EXCEEDED
    SYMLINK_CHANGE_NOT_ALLOWED
    SPECIAL_FILE_CHANGE_NOT_ALLOWED
    SUBMODULE_CHANGE_NOT_ALLOWED
    BINARY_CHANGE_NOT_ALLOWED
    BUNDLE_MUTATED

======================================================================
16. CANONICAL CHANGE-SET DIGEST
======================================================================

The digest must cover:

- base commit;
- branch name;
- relative path;
- change type;
- file mode;
- current content SHA-256;
- deletion markers;
- tracked Git diff SHA-256;
- untracked file content hashes.

The same change set must produce the same digest.

Changing one byte must change the digest.

Every review verdict is valid only for one exact digest.

If the digest changes:

- previous verifier results are stale;
- previous Terra review approval is stale;
- previous Sol review approval is stale.

======================================================================
17. DETERMINISTIC VERIFIER
======================================================================

The verifier is not an LLM.

It executes validation commands in listed order.

Required commands must all pass.

Optional command failures are recorded but do not automatically fail unless
an acceptance criterion depends on them.

The verifier must:

- use child_process spawn or execFile;
- never use a shell;
- use executable and argv arrays;
- resolve cwd safely;
- use minimal trusted environment;
- enforce timeout;
- terminate the command process group on timeout where supported;
- cap stdout independently;
- cap stderr independently;
- preserve bounded output tails;
- record exit code;
- record termination signal;
- record timeout status;
- record duration using a monotonic timer;
- calculate command specification hash;
- execute sequentially;
- never print environment values;
- never print credentials.

Do not send the task to Terra internal review until all required commands
pass.

======================================================================
18. SANDBOXED VERIFICATION
======================================================================

Validation commands execute repository code.

They must not run unrestricted on the host.

Implement VerificationSandbox as an interface.

Production implementation must use the supported Codex sandbox mechanism
available with the pinned runtime.

Tests must use FakeVerificationSandbox.

Requirements:

- worktree is the only writable project root;
- network is disabled;
- credential directories are not exposed;
- no additional writable root;
- no silent fallback to unrestricted host execution;
- shell execution is forbidden;
- helper arguments are passed as arrays;
- runtime behavior is covered by tests.

If sandbox enforcement is unavailable:

    VERIFIER_SANDBOX_UNAVAILABLE

======================================================================
19. VERIFIER EXECUTABLE POLICY
======================================================================

Executable must appear in trusted allowed_executables.

Additional restrictions:

- git is limited to read-only subcommands:
  - diff
  - status
  - rev-parse
  - ls-files
  - show

Reject:

- git add
- git commit
- git checkout
- git switch
- git reset
- git clean
- git branch
- git tag
- git fetch
- git pull
- git push
- git merge
- git rebase
- git worktree
- gh
- curl
- wget
- docker
- podman
- kubectl
- helm
- terraform
- tofu
- cloud CLIs
- npm install
- npm publish
- global package installation
- package publishing
- commands requiring network.

npm run <script> and npm test may execute repository scripts, but only
inside the verifier sandbox.

======================================================================
20. VERIFIER SIDE-EFFECT CHECK
======================================================================

Before and after every verifier command, snapshot the worktree.

Classify changes as:

- tracked source mutation;
- declared generated artifact;
- unexpected mutation.

Rules:

- validation must not modify tracked source;
- generated artifacts must match trusted allowed_generated_paths;
- generated artifacts must remain inside the worktree;
- generated symlinks are rejected;
- generated special files are rejected;
- unknown paths are not automatically deleted;
- tracked source mutation returns VERIFIER_MUTATED_SOURCE;
- generated artifacts are recorded separately;
- generated artifacts must not be committed by Phase 5.

======================================================================
21. VERIFICATION RESULT STORAGE
======================================================================

Store:

runs/<task-id>/<archive-sha256>/execution/
├── implementation/
│   ├── assessment.json
│   ├── iteration-001.json
│   ├── iteration-002.json
│   └── ...
├── verification/
│   ├── round-001/
│   │   ├── summary.json
│   │   ├── <command-id>.json
│   │   ├── <command-id>.stdout.log
│   │   └── <command-id>.stderr.log
│   └── ...
├── terra-review/
│   ├── round-001/
│   │   └── verdict.json
│   └── ...
├── sol-review/
│   ├── round-001/
│   │   └── verdict.json
│   └── ...
├── evidence/
├── agent-events.jsonl
└── execution.json

Command result:

{
  "result_version": "1.0",
  "command_id": "test",
  "specification_sha256": "...",
  "executable": "npm",
  "args": ["test"],
  "cwd": ".",
  "environment_keys": ["CI"],
  "started_at": "...",
  "finished_at": "...",
  "duration_ms": 1234,
  "exit_code": 0,
  "signal": null,
  "timed_out": false,
  "stdout_bytes": 1000,
  "stderr_bytes": 0,
  "stdout_truncated": false,
  "stderr_truncated": false,
  "generated_paths": [],
  "status": "PASS"
}

Do not store environment values.

======================================================================
22. TERRA INTERNAL REVIEW
======================================================================

Terra internal review is mandatory.

Start a fresh Terra reviewer thread after deterministic verification passes.

Never reuse the Terra implementer thread.

The Terra reviewer receives only:

- original request;
- plan;
- binding rules;
- acceptance criteria;
- test matrix;
- validation contract;
- risk policy;
- exact base commit;
- exact branch;
- current change-set digest;
- actual tracked diff;
- changed-file metadata;
- untracked-file metadata and hashes;
- acceptance evidence;
- deterministic verification summary;
- bounded command output;
- Terra implementer final summary.

Do not provide:

- implementer hidden reasoning;
- complete implementer transcript;
- unbounded logs;
- credentials;
- environment values;
- irrelevant failed attempts.

Before and after Terra review:

- verify HEAD;
- verify branch;
- verify accepted bundle digest;
- verify change-set digest;
- verify no file changed.

Terra review output:

{
  "verdict": "APPROVE | REVISE | REPLAN | ESCALATE",

  "reviewed_change_set_sha256": "64 lowercase hexadecimal characters",

  "summary": "string",

  "acceptance_results": [
    {
      "acceptance_id": "AC-001",
      "status": "PASS | FAIL | UNVERIFIED",
      "evidence": [
        "string"
      ]
    }
  ],

  "blocking_findings": [
    {
      "id": "TERRA-REV-001",
      "severity": "medium | high | critical",
      "category": "correctness | security | regression | scope |
                   tests | maintainability | performance",
      "file": "relative/path",
      "line_start": 1,
      "line_end": 10,
      "acceptance_ids": ["AC-001"],
      "problem": "string",
      "evidence": "string",
      "required_fix": "string"
    }
  ],

  "non_blocking_findings": [],

  "scope_violations": [],

  "unverified_acceptance": [],

  "recommended_next_state":
    "SOL_REVIEWING | TERRA_FIXING | WEB_REVIEW_REQUIRED | HUMAN_REQUIRED",

  "human_action": null
}

Terra APPROVE is invalid unless:

- verifier PASS;
- reviewed digest matches current digest;
- zero blocking findings;
- zero scope violations;
- every required acceptance criterion is PASS;
- zero required unverified acceptance criteria;
- worktree unchanged;
- reviewer thread differs from implementer thread.

If Terra returns REVISE:

1. validate every finding;
2. resume the original Terra implementer thread;
3. send only validated blocking findings;
4. Terra applies fixes;
5. rerun path policy;
6. rerun all required validation commands;
7. calculate a new change-set digest;
8. start a fresh Terra review thread.

Never reuse a Terra approval after any change.

======================================================================
23. SOL FINAL REVIEW
======================================================================

Sol review may start only after a valid Terra APPROVE for the current digest.

Start Sol in a new independent thread.

Sol receives:

- original request;
- plan;
- binding rules;
- acceptance criteria;
- test matrix;
- validation contract;
- risk policy;
- exact base commit;
- exact branch;
- current change-set digest;
- actual diff;
- changed-file metadata;
- untracked-file metadata and hashes;
- acceptance evidence;
- deterministic verification summary;
- bounded command output;
- Terra implementation summary;
- Terra review verdict as evidence, not as authority.

Sol must independently verify the implementation.

Before and after Sol review:

- verify HEAD;
- verify branch;
- verify accepted bundle digest;
- verify current change-set digest;
- verify no file changed.

Sol output:

{
  "verdict": "APPROVE | REVISE | REPLAN | ESCALATE",

  "reviewed_change_set_sha256": "64 lowercase hexadecimal characters",

  "summary": "string",

  "acceptance_results": [
    {
      "acceptance_id": "AC-001",
      "status": "PASS | FAIL | UNVERIFIED",
      "evidence": [
        "string"
      ]
    }
  ],

  "blocking_findings": [
    {
      "id": "SOL-001",
      "severity": "medium | high | critical",
      "category": "correctness | security | regression | scope |
                   tests | maintainability | performance",
      "file": "relative/path",
      "line_start": 1,
      "line_end": 10,
      "acceptance_ids": ["AC-001"],
      "problem": "string",
      "evidence": "string",
      "required_fix": "string"
    }
  ],

  "non_blocking_findings": [],
  "scope_violations": [],
  "unverified_acceptance": [],
  "human_action": null
}

Sol APPROVE is invalid unless:

- Terra reviewer APPROVE exists for the same digest;
- deterministic verifier PASS exists for the same digest;
- zero blocking findings;
- zero scope violations;
- every required acceptance criterion is PASS;
- zero required unverified acceptance criteria;
- reviewed digest equals current digest;
- worktree unchanged.

If Sol returns REVISE:

1. validate findings;
2. resume original Terra implementer thread;
3. Terra fixes the findings;
4. rerun full path policy;
5. rerun all required verifier commands;
6. calculate a new digest;
7. start a fresh Terra reviewer thread;
8. require a new Terra APPROVE;
9. start a fresh Sol reviewer thread.

Do not skip Terra review after a Sol correction.

Do not reuse an old Terra or Sol approval after the digest changes.

======================================================================
24. HARD GATING INVARIANTS
======================================================================

Implement explicit assertions:

- Sol cannot run before verifier PASS.
- Sol cannot run before Terra APPROVE.
- Sol cannot review a different digest from Terra.
- Terra APPROVE cannot survive a digest change.
- Sol APPROVE cannot survive a digest change.
- Every Terra fix invalidates previous verification and reviews.
- Every Sol-requested fix invalidates previous verification and reviews.
- READY_FOR_PUBLISH requires both reviewers to approve the same digest.
- READY_FOR_PUBLISH requires required validation commands to pass for that
  same digest.

Required final condition:

    verifier.change_set_sha256
    == terra_review.reviewed_change_set_sha256
    == sol_review.reviewed_change_set_sha256
    == execution.change_set_sha256

======================================================================
25. STATE MACHINE
======================================================================

Add states:

- READY_FOR_CODEX
- CODEX_PREFLIGHT
- TERRA_ASSESSING
- TERRA_IMPLEMENTING
- POLICY_CHECKING
- VERIFYING
- TERRA_FIXING
- TERRA_REVIEWING
- SOL_REVIEWING
- READY_FOR_PUBLISH
- REPLAN_REQUIRED
- WEB_REVIEW_REQUIRED
- HUMAN_REQUIRED
- POLICY_BLOCKED
- VERIFICATION_FAILED
- AGENT_FAILED
- BUDGET_EXHAUSTED
- INTERRUPTED
- FAILED

Allowed transitions must be explicit.

Reject invalid state transitions.

Every transition must be appended to events.jsonl.

Each event:

{
  "event_version": "1.0",
  "run_id": "string",
  "sequence": 1,
  "from": "READY_FOR_CODEX",
  "to": "CODEX_PREFLIGHT",
  "timestamp": "<ISO-8601 UTC>",
  "details": {}
}

Sequence numbers must increase monotonically.

Do not store secrets or complete prompts.

======================================================================
26. EXECUTION RECEIPT
======================================================================

execution.json:

{
  "execution_version": "1.0",
  "run_id": "TASK-ID:archive-sha256",
  "state": "READY_FOR_PUBLISH",
  "base_commit": "...",
  "branch_name": "...",
  "worktree_path": "...",
  "accepted_bundle_path": "...",

  "implementer": {
    "model": "gpt-5.6-terra",
    "reasoning_effort": "high",
    "thread_id": "...",
    "iterations": 4
  },

  "internal_reviewer": {
    "model": "gpt-5.6-terra",
    "reasoning_effort": "high",
    "rounds": 2,
    "latest_thread_id": "...",
    "verdict": "APPROVE",
    "reviewed_change_set_sha256": "..."
  },

  "final_reviewer": {
    "model": "gpt-5.6-sol",
    "reasoning_effort": "high",
    "rounds": 1,
    "latest_thread_id": "...",
    "verdict": "APPROVE",
    "reviewed_change_set_sha256": "..."
  },

  "verification": {
    "rounds": 4,
    "required_commands_passed": true,
    "verified_change_set_sha256": "..."
  },

  "change_set_sha256": "...",

  "usage": {
    "input_tokens": 0,
    "cached_input_tokens": 0,
    "output_tokens": 0
  },

  "errors": [],
  "created_at": "...",
  "updated_at": "..."
}

Use atomic writes.

Never expose partially written JSON.

======================================================================
27. BUDGET ENFORCEMENT
======================================================================

Track separately:

- implementation iterations;
- Terra internal review rounds;
- Sol final review rounds;
- total agent turns;
- wall-clock duration;
- available reported input tokens;
- available reported cached input tokens;
- available reported output tokens.

Check budget before every model turn.

When a limit is reached:

    BUDGET_EXHAUSTED

Do not start another model turn.

A Sol REVISE cycle consumes:

- one Terra implementation iteration;
- one full verification round;
- one new Terra review round;
- one new Sol review round.

If usage metadata is unavailable, still enforce:

- turn count;
- review count;
- iteration count;
- wall-clock limits.

======================================================================
28. TIMEOUT AND CANCELLATION
======================================================================

Every agent turn and verifier command must support AbortSignal.

On SIGINT or SIGTERM:

- request cancellation;
- stop starting new operations;
- wait for bounded cleanup;
- persist resumable state;
- release execution lock;
- do not delete valid implementation changes;
- do not mark READY_FOR_PUBLISH;
- set state INTERRUPTED where appropriate.

Exit codes:

- 130 for SIGINT where supported;
- 143 for SIGTERM where supported.

======================================================================
29. EXECUTION LOCK
======================================================================

Add:

    <state-dir>/locks/execution-<archive-sha256>.lock

Rules:

- use exclusive creation;
- include PID and timestamp;
- only one Phase 4 executor per run;
- remove lock on clean completion;
- remove lock after bounded interruption cleanup;
- do not automatically remove an existing lock;
- stale lock recovery remains manual.

Existing lock returns:

    EXECUTION_LOCKED

======================================================================
30. IDEMPOTENCY AND RESUME
======================================================================

Executing an already completed READY_FOR_PUBLISH run must:

- return existing receipt;
- not start Terra;
- not run verifier;
- not start Terra reviewer;
- not start Sol reviewer;
- not modify the worktree.

For resumable states:

- resume implementer thread where appropriate;
- do not resume a completed reviewer thread for a new digest;
- create a new Terra reviewer thread for each digest;
- create a new Sol reviewer thread for each digest;
- rerun verification when digest changed;
- verify persisted paths and digests before resuming.

If receipt and worktree disagree:

    EXECUTION_RECEIPT_INCONSISTENT

If the worktree was manually modified:

- calculate the current digest;
- invalidate stale verification;
- invalidate stale Terra review;
- invalidate stale Sol review;
- do not silently claim previous approval remains valid.

======================================================================
31. CLI
======================================================================

Add:

    wco execute
      --run-id <task-id:archive-sha256>
      --state-dir <directory>
      --config <config.json>
      [--json]

    wco execution-status
      --run-id <task-id:archive-sha256>
      --state-dir <directory>
      [--json]

execute:

- starts or resumes Phase 4;
- acquires execution lock;
- ends at a terminal or blocked state.

execution-status:

- reads status only;
- never starts Codex;
- never starts verifier;
- never modifies files.

Exit codes:

- 0:
  READY_FOR_PUBLISH

- 1:
  contract rejection,
  REPLAN_REQUIRED,
  WEB_REVIEW_REQUIRED,
  HUMAN_REQUIRED,
  POLICY_BLOCKED,
  VERIFICATION_FAILED,
  BUDGET_EXHAUSTED

- 2:
  invalid CLI usage

- 3:
  operational error,
  Codex failure,
  sandbox failure,
  lock failure,
  I/O failure,
  inconsistent receipt

- 130:
  SIGINT

- 143:
  SIGTERM

With --json:

- stdout contains exactly one valid JSON object;
- no decorative output on stdout;
- diagnostics go to stderr.

Without --json:

- display current state;
- display implementation iteration count;
- display verification round count;
- display Terra review count and latest verdict;
- display Sol review count and latest verdict;
- display artifact paths;
- never display credentials;
- never display full prompts.

======================================================================
32. REQUIRED ERROR CODES
======================================================================

At minimum:

EXECUTION_SCHEMA_UPGRADE_REQUIRED
EXECUTION_CONFIG_INVALID
EXECUTION_STATE_INVALID
EXECUTION_LOCKED
EXECUTION_RECEIPT_INCONSISTENT
CODEX_RUNTIME_NOT_FOUND
CODEX_AUTH_UNAVAILABLE
CODEX_SANDBOX_UNAVAILABLE
CODEX_TURN_TIMEOUT
CODEX_TURN_FAILED
AGENT_OUTPUT_INVALID
AGENT_ASSESSMENT_MUTATED_WORKTREE
AGENT_COMMITTED_CHANGES
AGENT_CHANGED_BRANCH
BUNDLE_MUTATED
PATH_POLICY_VIOLATION
FORBIDDEN_PATH_CHANGED
CHANGE_LIMIT_EXCEEDED
SYMLINK_CHANGE_NOT_ALLOWED
SPECIAL_FILE_CHANGE_NOT_ALLOWED
SUBMODULE_CHANGE_NOT_ALLOWED
BINARY_CHANGE_NOT_ALLOWED
VALIDATION_CONTRACT_INVALID
VALIDATION_EXECUTABLE_DENIED
VALIDATION_ENVIRONMENT_DENIED
VALIDATION_CWD_UNSAFE
VERIFIER_SANDBOX_UNAVAILABLE
VERIFIER_TIMEOUT
VERIFIER_OUTPUT_LIMIT
VERIFIER_MUTATED_SOURCE
VERIFICATION_FAILED
TERRA_REVIEW_REQUIRED
TERRA_REVIEW_OUTPUT_INVALID
TERRA_REVIEW_STALE
TERRA_REVIEW_MUTATED_WORKTREE
SOL_REVIEW_NOT_ALLOWED
REVIEW_OUTPUT_INVALID
REVIEW_STALE
REVIEW_MUTATED_WORKTREE
REPLAN_REQUIRED
HUMAN_REQUIRED
BUDGET_EXHAUSTED
INTERRUPTED
OPERATIONAL_ERROR

Tests must assert error codes, not free-form error messages.

======================================================================
33. IMPLEMENTATION STRUCTURE
======================================================================

Create or update:

src/
├── agent/
│   ├── contracts.ts
│   ├── agent-client.ts
│   ├── codex-sdk-client.ts
│   ├── fake-agent-client.ts
│   ├── output-validator.ts
│   ├── prompt-builder.ts
│   ├── terra-implementer.ts
│   ├── terra-reviewer.ts
│   └── sol-reviewer.ts
│
├── execution/
│   ├── contracts.ts
│   ├── errors.ts
│   ├── execution-config.ts
│   ├── execution-store.ts
│   ├── execution-lock.ts
│   ├── state-machine.ts
│   ├── budget.ts
│   ├── bundle-integrity.ts
│   ├── change-set.ts
│   ├── path-policy.ts
│   ├── review-gates.ts
│   └── execution-service.ts
│
├── verifier/
│   ├── contracts.ts
│   ├── validation-contract.ts
│   ├── executable-policy.ts
│   ├── environment-policy.ts
│   ├── sandbox-interface.ts
│   ├── codex-sandbox.ts
│   ├── fake-sandbox.ts
│   ├── command-runner.ts
│   ├── side-effect-check.ts
│   └── verifier.ts
│
├── evidence/
│   ├── acceptance-evidence.ts
│   ├── log-redaction.ts
│   └── evidence-builder.ts
│
└── cli/
    └── index.ts

Tests:

tests/
├── existing Phase 1 tests
├── existing Phase 2 tests
├── existing Phase 3 tests
├── execution-contract.test.ts
├── execution-state-machine.test.ts
├── agent-output.test.ts
├── terra-loop.test.ts
├── terra-review.test.ts
├── review-gates.test.ts
├── path-policy.test.ts
├── change-set.test.ts
├── verifier-policy.test.ts
├── verifier-runner.test.ts
├── sol-review.test.ts
├── execution-resume.test.ts
├── execution-cli.test.ts
└── helpers/
    ├── fake-agent.ts
    ├── fake-sandbox.ts
    ├── execution-fixture.ts
    └── phase4-bundle-fixture.ts

Also:

- update bundle contract for schema 1.3;
- update Phase 3 preparation to accept schema 1.3;
- update default bundle template;
- regenerate checksums.json;
- extend trusted config contract;
- update examples/config.example.json;
- update README.md;
- update AGENTS.md;
- update SECURITY.md;
- update CHANGELOG.md;
- create PHASE4.md;
- create PHASE4-COVERAGE.md;
- update package.json;
- update package-lock.json.

======================================================================
34. TEST RULES
======================================================================

Normal CI tests must never:

- invoke real Codex;
- contact OpenAI;
- consume model quota;
- require Codex authentication;
- contact the public network;
- use the user's real repository;
- use the user's actual state directory;
- execute a downloaded payload;
- push a branch;
- create a Pull Request;
- invoke a browser.

Use:

- FakeAgentClient;
- FakeVerificationSandbox;
- generated temporary Git repositories;
- generated temporary task bundles;
- isolated temporary directories.

Add optional real integration test:

    WCO_RUN_CODEX_INTEGRATION=1 npm run test:codex-integration

The optional integration test must:

- use a generated toy repository;
- use a temporary state directory;
- use no real project repository;
- not push;
- not create a PR;
- not run in GitHub Actions by default.

If authentication is unavailable, report that the optional integration
test was not run.

Do not fabricate a successful real Codex test.

======================================================================
35. DEFINITION OF DONE
======================================================================

All standard commands must pass:

    npm ci
    npm run validate -- ./templates/task-bundle
    npm run typecheck
    npm test
    npm run build

The normal test suite must:

- use fake agents;
- consume zero model quota;
- make zero public network requests.

The implementation is complete only when tests prove:

1. Terra assessment occurs before implementation;
2. Terra implementation occurs before verification;
3. required verification passes before Terra review;
4. Terra internal review is mandatory;
5. Terra reviewer uses a different thread from implementer;
6. Sol cannot start before Terra APPROVE;
7. Terra and Sol approve the same digest;
8. a Terra fix invalidates both previous reviews;
9. a Sol-requested fix reruns verifier and Terra review;
10. READY_FOR_PUBLISH requires verifier, Terra, and Sol approval for the
    same exact digest.

Create Draft Pull Request:

    Add Terra implementation and mandatory dual-review pipeline Phase 4

Do not merge it.

At completion report:

- final commit SHA;
- files changed;
- dependencies added;
- total tests executed;
- P4 coverage map;
- all command exit codes;
- whether optional real Codex integration ran;
- Terra implementation iterations;
- verification rounds;
- Terra internal review rounds;
- Sol review rounds;
- example READY_FOR_PUBLISH receipt;
- confirmation that no payload was auto-executed;
- confirmation that no commit was created;
- confirmation that no remote branch was changed;
- confirmation that no push occurred;
- confirmation that no GitHub API was called;
- confirmation that no Pull Request was created except the requested Draft
  PR for this Phase 4 implementation branch;
- confirmation that no browser automation occurred.

Test matrix Phase 4 đầy đủ

Agent có thể gom nhiều ID trong một integration test, nhưng mỗi ID phải xuất hiện trong tên test hoặc PHASE4-COVERAGE.md.

Contract và config
ID	Trường hợp	Kết quả
P4-001	Schema 1.3 hợp lệ	Pass
P4-002	Execute schema 1.2	EXECUTION_SCHEMA_UPGRADE_REQUIRED
P4-003	Validation còn dùng command string	Reject
P4-004	Executable là absolute path	Reject
P4-005	Executable chứa slash/backslash	Reject
P4-006	cwd=../outside	VALIDATION_CWD_UNSAFE
P4-007	Environment chứa PATH	VALIDATION_ENVIRONMENT_DENIED
P4-008	Environment chứa token giả	Reject và không ghi token
P4-009	Bundle cố chọn model	Ignore/reject
P4-010	Bundle cố bật network	Reject
P4-011	Trusted config có field lạ	EXECUTION_CONFIG_INVALID
P4-012	Local limit thấp hơn bundle	Dùng local limit
Runtime và assessment
ID	Trường hợp	Kết quả
P4-013	Run không ở trạng thái phù hợp	EXECUTION_STATE_INVALID
P4-014	Worktree bị mất	Receipt inconsistent
P4-015	HEAD không còn base commit	Reject
P4-016	Branch bị đổi	AGENT_CHANGED_BRANCH
P4-017	Accepted bundle bị sửa	BUNDLE_MUTATED
P4-018	Codex runtime không có	CODEX_RUNTIME_NOT_FOUND
P4-019	Sandbox không khả dụng	CODEX_SANDBOX_UNAVAILABLE
P4-020	Assessment COMPATIBLE	Tiếp tục
P4-021	Assessment REPLAN_REQUIRED	Dừng
P4-022	Assessment HUMAN_REQUIRED	Dừng
P4-023	Assessment sửa file	AGENT_ASSESSMENT_MUTATED_WORKTREE
P4-024	Assessment sai schema	Một repair turn rồi fail
Terra implementer và path policy
ID	Trường hợp	Kết quả
P4-025	Tạo file hợp lệ trong allowed path	Pass
P4-026	Sửa forbidden path	Block
P4-027	Tạo symlink	Block
P4-028	Tạo FIFO/special file	Block
P4-029	Terra tạo commit	AGENT_COMMITTED_CHANGES
P4-030	Terra đổi branch	AGENT_CHANGED_BRANCH
P4-031	Sửa .gitmodules	Block
P4-032	Sửa submodule	Block
P4-033	Quá số file	CHANGE_LIMIT_EXCEEDED
P4-034	Quá số dòng diff	CHANGE_LIMIT_EXCEEDED
P4-035	Binary file không được phép	Block
P4-036	Agent khai sai changed files	Dùng dữ liệu thật
P4-037	Cùng change set	Cùng digest
P4-038	Thay một byte	Digest đổi
Deterministic verifier
ID	Trường hợp	Kết quả
P4-039	Mọi required command pass	Verification PASS
P4-040	Required command fail	Trả Terra sửa
P4-041	Optional command fail	Ghi nhận
P4-042	Command timeout	VERIFIER_TIMEOUT
P4-043	Stdout vượt limit	Truncate đúng
P4-044	Stderr vượt limit	Truncate đúng
P4-045	Không dùng shell	Pass
P4-046	Executable không allowlist	Deny
P4-047	git push	Deny
P4-048	npm publish	Deny
P4-049	npm install	Deny
P4-050	Sandbox helper không có	Không fallback host
P4-051	Verifier sửa tracked source	VERIFIER_MUTATED_SOURCE
P4-052	Tạo generated artifact cho phép	Ghi nhận
Terra internal reviewer
ID	Trường hợp	Kết quả
P4-053	Verifier chưa pass	Không gọi Terra reviewer
P4-054	Terra reviewer dùng thread implementer	Reject
P4-055	Terra reviewer có read-only sandbox	Pass
P4-056	Terra APPROVE hợp lệ	Cho phép Sol
P4-057	Terra APPROVE có blocking finding	Invalid
P4-058	Terra APPROVE nhưng AC unverified	Invalid
P4-059	Terra REVISE	Resume implementer
P4-060	Terra REPLAN	WEB_REVIEW_REQUIRED
P4-061	Terra ESCALATE	HUMAN_REQUIRED
P4-062	Terra trả digest cũ	TERRA_REVIEW_STALE
P4-063	Terra reviewer sửa file	Invalid
P4-064	Finding trỏ file không tồn tại	Invalid
P4-065	Terra sửa sau review	Rerun verifier
P4-066	Digest đổi sau Terra approval	Approval bị vô hiệu
P4-067	Terra review thread mới cho digest mới	Pass
P4-068	Hết Terra review budget	BUDGET_EXHAUSTED
Sol final reviewer
ID	Trường hợp	Kết quả
P4-069	Sol gọi trước Terra approve	Không được gọi
P4-070	Sol dùng thread khác mọi Terra thread	Pass
P4-071	Sol read-only	Pass
P4-072	Sol APPROVE hợp lệ	READY_FOR_PUBLISH
P4-073	Sol APPROVE có blocking finding	Invalid
P4-074	Sol APPROVE còn AC unverified	Invalid
P4-075	Sol REVISE	Terra sửa
P4-076	Sol REPLAN	WEB_REVIEW_REQUIRED
P4-077	Sol ESCALATE	HUMAN_REQUIRED
P4-078	Sol trả digest cũ	REVIEW_STALE
P4-079	Sol sửa file	Invalid
P4-080	Sol finding trỏ file không tồn tại	Invalid
Vòng lặp bắt buộc
ID	Trường hợp	Kết quả
P4-081	Verifier fail rồi Terra sửa	Verify lại
P4-082	Terra REVISE rồi Terra sửa	Verify + Terra review lại
P4-083	Sol REVISE rồi Terra sửa	Verify + Terra review + Sol lại
P4-084	Sol vòng hai chạy trước Terra vòng hai	Test fail
P4-085	Terra approval thuộc digest A, Sol nhận digest B	Không gọi Sol
P4-086	Terra và Sol approve cùng digest	Ready
P4-087	Verifier digest khác review digest	Không Ready
P4-088	Worktree đổi sau Terra review	Terra approval stale
P4-089	Worktree đổi sau Sol review	Sol approval stale
P4-090	Sol approval cũ được reuse	Reject
Resume, budget, CLI và security
ID	Trường hợp	Kết quả
P4-091	Hết implementation iterations	BUDGET_EXHAUSTED
P4-092	Hết Sol review rounds	BUDGET_EXHAUSTED
P4-093	Hết token budget	BUDGET_EXHAUSTED
P4-094	Turn timeout	CODEX_TURN_TIMEOUT
P4-095	Execute run đã hoàn tất	Không chạy lại
P4-096	Restart process	Resume implementer
P4-097	Receipt không khớp worktree	Reject
P4-098	Hai executor cùng run	EXECUTION_LOCKED
P4-099	execute --json	Một JSON object
P4-100	execution-status	Không gọi agent
P4-101	Payload tạo marker nếu chạy	Marker không xuất hiện
P4-102	Fake agent yêu cầu network	Không cấp network
P4-103	Fake agent yêu cầu credential	Không cấp
P4-104	Prompt chứa token giả	Redact khỏi artifacts
P4-105	SIGINT	Persist và unlock
P4-106	SIGTERM	Persist và unlock
P4-107	Phase 1–3 regression suite	Pass
P4-108	Normal CI	Không gọi Codex/OpenAI thật
Điều kiện cuối cùng bắt buộc

Agent không được coi Phase 4 hoàn thành nếu thiếu bất kỳ điều kiện nào:

✓ Terra assessment = COMPATIBLE
✓ Terra implementer hoàn thành implementation
✓ Path policy PASS
✓ Required deterministic validation PASS
✓ Terra internal reviewer APPROVE
✓ Sol final reviewer APPROVE
✓ Verifier, Terra và Sol cùng review một change-set digest
✓ Worktree không đổi sau final review
✓ Không tạo commit
✓ Không push
✓ Không tạo PR sản phẩm
✓ Không tự chạy payload

Kết quả cuối của Phase 4:

READY_FOR_PUBLISH