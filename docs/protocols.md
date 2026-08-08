# Protocols and Authority

This document describes the product-level protocol boundaries. JSON schemas, canonical validators, and executable tests remain normative when prose and implementation disagree.

## Run identity

A run is identified by the task identity plus the accepted Task Bundle archive SHA-256. The exact accepted bundle, repository registration, base commit, delivery branch, and state root are rebound throughout later transitions.

## Task Bundle

Task Bundles are untrusted input. Intake validates archive structure, path safety, supported entries, checksum coverage, schema versions, and size/count limits before accepted bytes become run authority.

The template under `templates/task-bundle/` is the current reference shape. A successful directory validation proves contract validity; secure intake/preparation still determines whether the bundle is executable.

## Web implementation authority

External implementation work becomes authority only after a Web implementation pack is registered against the exact repository snapshot and accepted specification.

The pack binds, among other fields:

- repository inventory and Git object identities;
- read coverage/project-map evidence;
- architecture/acceptance/prohibited-change locks;
- exact create/replace/delete operations;
- exact preimages for existing files;
- payload hashes and closed-world checksums.

Registration is content-addressed. Loose prompts, patches, clipboard text, or a different archive cannot override a registered artifact.

Public schemas live in `schemas/`.

## Deterministic execution

The executor independently revalidates the registered artifact and all operation preimages before the first product write. It then applies exact registered bytes, verifies postimages, runs deterministic verification, and requires independent Terra and Sol approval of the same exact change-set digest.

Reviewers can reject or escalate. They do not gain authority to invent new filesystem operations.

## Git and Draft PR publication

Publication commits only the exact approved change set to the configured delivery branch. Initial branch creation uses an expected-absent compare-and-swap guard so a racing remote branch cannot be silently overwritten. Revisions are ordinary fast-forward updates of the same branch.

A pull request is accepted only when it is open, unmerged, Draft, in the expected repository, and has the exact base/head identity. WCO does not expose merge, Mark Ready, auto-merge, or branch-deletion authority.

## Result Bundle

A Result Bundle is a deterministic handoff archive containing bounded public evidence for the exact published run/head. The archive is independently verified before its durable receipt can advance the workflow.

The embedded review contract and verdict schema under `src/result-bundle/resources/` are runtime resources and are shipped with the compiled package.

## Web verdict and revision

A verdict source is untrusted until bounded stable read, canonicalization, schema/policy validation, Result Bundle identity checks, and fresh Draft PR attestation all agree.

An approval stops at human merge authority. A revision request seals only the fixable findings and authorizes a bounded same-PR revision. Each completed revision produces a new exact head and Result Bundle for the next explicit verdict.

## Durable orchestration

The controller checkpoints an exact request before external/model/mutating work. Attempts are fenced by identity, retries use durable budgets/backoff, and crash recovery adopts prior side effects only after re-attestation.

Session/transcript/browser state is never searched to synthesize missing protocol input.
