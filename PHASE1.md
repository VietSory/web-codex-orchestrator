# Phase 1 — Bundle contract and validator

This phase intentionally does not call Codex.

## Install

```bash
npm install
```

## Validate the included example

```bash
npm run validate -- ./templates/task-bundle
```

## Run checks

```bash
npm run typecheck
npm test
npm run build
```

## Definition of done

- Missing required files are rejected.
- Invalid JSON is rejected.
- Unsafe paths are rejected.
- Shell operators and dangerous validation commands are rejected.
- Duplicate acceptance/test IDs are rejected.
- Acceptance references must point to existing test cases.
