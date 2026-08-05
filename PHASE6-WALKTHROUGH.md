# Phase 6 Implementation Walkthrough

This walkthrough details the fixes applied to the `codex/phase-6-result-bundle-handoff` branch for Phase 6.

## Fixes Implemented

1. **Embedded Resources**: The `build` script in `package.json` now copies `src/result-bundle/resources` to `dist/result-bundle/resources`. A CLI integration test (`tests/integration/cli-phase6.integration.test.ts`) verifies the compiled CLI successfully loads them without throwing file not found errors.
2. **Phase 5A Receipt Path**: Updated `result-bundle-service.ts` to read `git-publish.json` from the authoritative per-run execution publish path (`executionPaths(...).directory / "publish" / "git-publish.json"`), removing global state directory dependencies.
3. **Execution Helpers**: Safely extracts `taskId` and `archiveSha` from `runId` and uses the robust `executionPaths` function from `execution-store.ts` to guarantee absolute path safety.
4. **`spec_set_sha256`**: Configured `specLockAuthoritativeFiles` to ingest all required task bundle files natively rather than just the manifest and request.
5. **Checksum Verification**: Bound `verifyBundleChecksums` directly into `packageResultBundle` to validate the full bundle integrity upstream, discarding the empty buffer fallback in `readTextFile` for required specs.
6. **ZIP Determinism**: Replaced `manifest.json`'s dynamic `created_at` field with the Phase 4 execution's deterministic `created_at` timestamp. Added `tests/phase6-determinism.test.ts` to strictly assert byte-for-byte equality of consecutive builds.
7. **Independent Verification**: Upgraded `verifyResultBundleZip` (`zip-verifier.ts`) to operate blindly by parsing the embedded `manifest.json` directly from the ZIP stream and asserting its structural integrity.
8. **State Idempotency**: Wired up full Phase 6 state transitions (`READY_FOR_WEB_REVIEW`). Idempotent requests for the same run re-verify the existing ZIP hash, never overwriting mismatched bundles.
9. **Per-Run Storage**: Updated `resultBundlePaths` to use nested per-run directories (`runs/<taskId>/<archiveSha>/result-bundle.json`) instead of a shared global receipt.
10. **Web Verdict Validator**: Added `web-verdict-validator.ts` which statically parses any incoming reviewer verdict against `web-review-verdict.schema.json`, validates it targets the exact bundle hash, and enforces set equality against `acceptance.json` IDs.
11. **Public Draft PR Evidence**: Adapted `projectDraftPrEvidence` to flat properties `pull_number` and `pull_url`, matching Phase 5B.
12. **Service Limits**: Plumbed Config `result_bundle` limit objects directly into zip and attestation layers, enabling memory bounds on large repo diffs. Passed secret configuration arrays into `scanForSecrets` to redact accidental trace disclosures.
13. **Full Content Assertions**: Enhanced `phase6-integration.test.ts` to parse the underlying zip (via `yauzl`), decode the `execution.json` / `github-draft-pr.json` payload and assert exact expected properties, not just hash presence.
14. **Documentation**: Restored the missing `RESULT-BUNDLE-SCHEMA.md` and added this committed walkthrough file.

## Verification
- Run `npm run test` to verify unit and determinism test matrix.
- Phase 6 Integration cleanly generates the result zip.
