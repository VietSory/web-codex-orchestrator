import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatGptCodexWebBridge } from "../src/web-bridge/chatgpt-codex-bridge.js";

function forceInteractiveTty(): () => void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  return () => {
    if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor); else Reflect.deleteProperty(process.stdin, "isTTY");
    if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor); else Reflect.deleteProperty(process.stdout, "isTTY");
  };
}

test("interactive local authoring completes ChatGPT auth before durable job creation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-interactive-auth-boundary-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const restoreTty = forceInteractiveTty();
  t.after(restoreTty);
  const previousCi = process.env.CI;
  delete process.env.CI;
  t.after(() => { if (previousCi === undefined) delete process.env.CI; else process.env.CI = previousCi; });

  const bridge = new ChatGptCodexWebBridge({ runtime: { source: "bundled" } } as any, path.join(root, "bridge"));
  const target = bridge as any;
  const originalCreate = target.store.create.bind(target.store);
  let createCalls = 0;
  target.store.create = async (...args: unknown[]) => { createCalls += 1; return await originalCreate(...args); };
  let authCalls = 0;
  target.ensureAuthorizedForProviderTurn = async () => { authCalls += 1; throw new Error("user cancelled official ChatGPT authorization"); };

  const request = {
    owner: "local-user",
    repository: { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) },
    user_intent: "change app",
    ttl_seconds: 600,
    orchestration_mode: "PAIR" as const,
  };

  await assert.rejects(() => bridge.createAuthoringJob(request, "first"), /cancelled official ChatGPT authorization/);
  assert.equal(authCalls, 1);
  assert.equal(createCalls, 0, "cancelled/failed auth must not leave a durable AUTHORING job");

  target.ensureAuthorizedForProviderTurn = async () => { authCalls += 1; };
  const identity = await bridge.createAuthoringJob(request, "second");
  assert.ok(identity.job_id);
  assert.equal(authCalls, 2);
  assert.equal(createCalls, 1, "job persistence starts only after interactive auth succeeds");
});
