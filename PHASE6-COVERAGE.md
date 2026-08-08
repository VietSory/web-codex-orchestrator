# Phase 6 Test Coverage

The following coverage principles are rigorously tested in Phase 6:

## Unit Tests
- **Canonical JSON:** Ensures all objects are strictly sorted and formatted identically.
- **GitHub Attestation:** Verifies safe read-only retrieval of PR information.
- **Public Evidence DTOs:** Validates sensitive information stripping and output length constraints.
- **CLI Commands:** Verifies strict argument validation and usage printing.

## Integration Tests
- **Full End-to-End Build (`tests/phase6-integration.test.ts`):** 
  - Initializes a real local Git repository.
  - Generates fake upstream receipts (Phase 4, 5A, 5B).
  - Triggers the complete `packageResultBundle` pipeline.
  - Verifies the ZIP is constructed successfully, hashed, and verifiable through `yauzl`.
  - Ensures the final receipt reflects the `READY_FOR_WEB_REVIEW` state.
