# WEB REVIEW CONTRACT — CLOSED-WORLD REVIEW

## Purpose

The Web reviewer is the final independent reviewer of one exact Result Bundle.
It is not a second product manager and may not expand the locked implementation
scope after the agent has implemented it.

The review universe is closed by:

1. the original task bundle;
2. `SPEC-LOCK.json`;
3. the locked acceptance criteria;
4. the locked test matrix;
5. the locked security invariants and non-goals;
6. the exact Result Bundle SHA-256.

## Allowed verdicts

```text
APPROVE
REVISE
ESCALATE
```

### APPROVE

Required when all locked required acceptance criteria are supported by valid
evidence, no locked invariant is violated, and no permitted blocking finding
exists.

`APPROVE` is the only normal verdict that creates a user notification asking:

```text
The implementation has passed all locked gates.
Do you want to merge the Pull Request?
```

The Web reviewer does not merge.

### REVISE

Allowed only when at least one concrete finding is mapped to:

- a locked acceptance criterion ID;
- a locked rule or invariant;
- exact file/line or artifact evidence;
- a required observable fix.

`REVISE` must not notify the user with a merge decision. It creates a structured
revision request and returns the task to the automated implementation,
verification, Terra review, Sol review, publication and Result Bundle process.

A revision request may correct only:

- `SPEC_VIOLATION`;
- `IMPLEMENTATION_DEFECT`;
- `EVIDENCE_GAP`;
- `REPOSITORY_DRIFT`.

It may not add a feature, preference, architecture goal, delivery channel,
security model, acceptance criterion or non-goal that was absent from the lock.

### ESCALATE

Allowed only when automation cannot safely continue, for example:

- an unavoidable contradiction inside the locked specification;
- human credentials or destructive approval are required;
- an external system changed in a way that invalidates the frozen assumptions;
- the Result Bundle is incomplete or cannot be trusted;
- a severe security fact has concrete evidence but cannot be expressed as a
  correction to an existing locked invariant.

`ESCALATE` may notify the user, but it is an exception notification, not a merge
prompt.

## Mandatory closed-world rule

If the implementation satisfies every locked required criterion and invariant,
the Web reviewer MUST return `APPROVE`.

The Web reviewer MUST NOT return `REVISE` because of:

- stylistic preference;
- a different architecture it would have chosen;
- an optional optimization;
- an additional feature;
- a newly imagined edge case outside the frozen threat model;
- a non-blocking maintainability suggestion;
- an undocumented personal standard.

Such observations may be recorded only as `NON_BLOCKING_BACKLOG` and must not
prevent approval.

## Blocking finding schema

Every blocking finding must include:

```text
finding_id
classification
locked_reference_ids[]
artifact_paths[]
line_or_json_pointer
expected_behavior
observed_behavior
evidence
minimal_required_fix
```

A finding without locked references and concrete evidence is invalid and cannot
produce `REVISE`.

## Artifact binding

The verdict must bind:

- run ID;
- Result Bundle SHA-256;
- manifest SHA-256;
- published commit SHA;
- Pull Request number;
- observed Pull Request head SHA;
- review contract version.

A verdict for another archive or commit is stale and must be rejected.
