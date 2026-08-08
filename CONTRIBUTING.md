# Contributing

WCO is a security-sensitive orchestration tool. Small, reviewable changes with explicit regression coverage are preferred over broad rewrites.

## Development setup

```bash
npm ci
npm run build
npm run check
```

See [docs/development.md](docs/development.md) for the repository layout and native integration tests.

## Pull requests

A change should:

- preserve fail-closed authority and human merge boundaries;
- include regression coverage for changed security, recovery, CLI, or resource behavior;
- keep external/process/model work bounded and cancellable;
- avoid introducing another source of lifecycle authority when an existing durable receipt or content identity already owns it;
- keep machine output stable when changing human-facing CLI text;
- update user-facing documentation when commands, configuration, packaging, or operational behavior changes;
- pass `npm run check` on the exact proposed head.

Do not weaken or delete a regression merely to obtain green CI. If a contract intentionally changes, make that change explicit and update all affected tests and documentation together.

## Native-only behavior

CI uses deterministic fakes and does not prove local Codex authentication, native sandbox behavior, or optional browser/bridge integration. Changes affecting those surfaces should also run the opt-in native tests on an appropriate machine before release.
