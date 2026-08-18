import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isSemanticChallengeAwareWebBridge } from "../src/semantic/challenge-aware-web-bridge.js";
import type { SemanticChallengeTransport } from "../src/semantic/challenge-aware-web-bridge.js";
import type { WebBridge } from "../src/web-bridge/web-bridge.js";

function ordinaryBridge(): WebBridge {
  return {
    async createAuthoringJob() { throw new Error("unused"); },
    async waitForAuthoringEvent() { return null; },
    async submitRepositoryCommandResult() {},
    async submitClarification() {},
    async receiveSealedContract() { return null; },
    async receiveWebImplementation() { return null; },
    async createFinalReviewJob() { throw new Error("unused"); },
    async submitFinalReviewEvidence() {},
    async waitForVerdict() { return null; },
    async getConnectionStatus() { return { configured: true, connected: true }; },
  } as WebBridge;
}

function semanticTransportOnly(): SemanticChallengeTransport {
  return {
    async createSemanticChallengeJob() { throw new Error("unused"); },
    async waitForSemanticChallengeAction() { return null; },
    async submitSemanticChallengeRepositoryResult() {},
    async receiveSemanticUnderstanding() { return null; },
  };
}

test("semantic transport is independently constructible without WebBridge authority", () => {
  const transport = semanticTransportOnly();
  assert.equal("createAuthoringJob" in transport, false);
  assert.equal("createFinalReviewJob" in transport, false);
  assert.equal("waitForVerdict" in transport, false);
});

test("semantic challenge capability is optional and requires the complete closed method set", () => {
  const base = ordinaryBridge();
  assert.equal(isSemanticChallengeAwareWebBridge(base), false);

  const partial = Object.assign(base, { async createSemanticChallengeJob() { throw new Error("unused"); } });
  assert.equal(isSemanticChallengeAwareWebBridge(partial), false, "one semantic-looking method must not opt an adapter into the capability");

  const full = Object.assign(ordinaryBridge(), semanticTransportOnly());
  assert.equal(isSemanticChallengeAwareWebBridge(full), true);
});

test("semantic challenge transport stays outside execution and base WebBridge core imports", async () => {
  const capabilitySource = await readFile("src/semantic/challenge-aware-web-bridge.ts", "utf8");
  assert.equal(capabilitySource.includes("interface SemanticChallengeTransport extends WebBridge"), false, "semantic transport must not inherit WebBridge authority");

  for (const target of [
    "src/executor/applier.ts",
    "src/executor/production-gates.ts",
    "src/web-bridge/web-bridge.ts",
  ]) {
    const source = await readFile(target, "utf8");
    assert.equal(source.includes("challenge-aware-web-bridge"), false, `${target} must not depend on semantic challenge transport`);
  }
});
