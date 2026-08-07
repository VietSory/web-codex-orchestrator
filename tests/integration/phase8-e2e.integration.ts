const E2E_NOW_MS = Date.parse("2026-08-07T12:20:00.000Z");
Date.now = () => E2E_NOW_MS;
await import("../phase8-e2e-support.js");
