import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistSemanticShadowObservation, semanticShadowReceiptPath } from "../src/semantic/shadow-observer.js";

const repository = { repository_id: "repo", base_branch: "main", base_commit: "a".repeat(40) } as const;
const sessionId = "11111111-1111-4111-8111-111111111111";
const blob = "b".repeat(40);
const sha = (bytes: Buffer | string) => crypto.createHash("sha256").update(bytes).digest("hex");

function readObservation(text = "maintainer evidence\n") {
  const bytes = Buffer.from(text, "utf8");
  return {
    command: { operation: "read", paths: ["src/app.ts"] },
    result: {
      files: [{
        path: "src/app.ts",
        content_base64: bytes.toString("base64"),
        content_sha256: sha(bytes),
        blob_sha: blob,
        size_bytes: bytes.length,
        start_byte: 0,
        end_byte_exclusive: bytes.length,
        total_bytes: bytes.length,
      }],
      metrics: {
        context_bytes_prepared: bytes.length,
        context_bytes_transmitted: bytes.length,
        repeated_bytes_avoided: 0,
        files_considered: 1,
        files_read: 1,
        regions_read: 1,
        cache_hits: 0,
        cache_misses: 1,
      },
    },
  };
}

test("shadow receipt is durable, deterministic and never persists repository source bytes", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-shadow-"));
  try {
    const read = readObservation("TOP_SECRET_SOURCE\n");
    const first = await persistSemanticShadowObservation({
      stateDirectory,
      sessionId,
      repository,
      eventSequence: 7,
      requestId: "req-read",
      command: read.command,
      result: read.result,
    });
    assert.equal(first.status, "created");
    assert.equal(first.receipt.event_sequence, 7);
    assert.match(first.receipt.receipt_sha256, /^[a-f0-9]{64}$/);
    assert.equal(first.receipt.evidence_index.observations.length, 1);

    const bytes = await readFile(first.path, "utf8");
    assert.doesNotMatch(bytes, /TOP_SECRET_SOURCE/);
    assert.doesNotMatch(bytes, new RegExp(Buffer.from("TOP_SECRET_SOURCE\n").toString("base64")));
    assert.doesNotMatch(bytes, /content_base64/);

    const replay = await persistSemanticShadowObservation({
      stateDirectory,
      sessionId,
      repository,
      eventSequence: 7,
      requestId: "req-read",
      command: read.command,
      result: read.result,
    });
    assert.equal(replay.status, "replayed");
    assert.equal(replay.path, first.path);
    assert.deepEqual(replay.receipt, first.receipt);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("same event/request identity cannot be overwritten with different evidence", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-shadow-conflict-"));
  try {
    const first = readObservation("alpha\n");
    await persistSemanticShadowObservation({ stateDirectory, sessionId, repository, eventSequence: 3, requestId: "same-request", command: first.command, result: first.result });
    const conflicting = readObservation("bravo\n");
    await assert.rejects(
      persistSemanticShadowObservation({ stateDirectory, sessionId, repository, eventSequence: 3, requestId: "same-request", command: conflicting.command, result: conflicting.result }),
      /replay conflicts with immutable existing evidence/i,
    );
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("receipt path is repository/session/event scoped and hashes request IDs instead of trusting them as paths", () => {
  const target = semanticShadowReceiptPath({ stateDirectory: "/tmp/state", repositoryId: "repo", sessionId, eventSequence: 12, requestId: "../../unsafe/request" });
  assert.equal(path.basename(target).startsWith("000000000012-"), true);
  assert.equal(path.basename(target).includes("unsafe"), false);
  assert.equal(path.dirname(target).endsWith(path.join("bridge", "semantic-shadow", "repo", sessionId)), true);
});

test("invalid repository/session identities fail before filesystem placement", async () => {
  const read = readObservation();
  await assert.rejects(
    persistSemanticShadowObservation({ stateDirectory: "/tmp/state", sessionId: "not-a-session", repository, eventSequence: 0, requestId: "req", command: read.command, result: read.result }),
    /session identity is invalid/i,
  );
  await assert.rejects(
    persistSemanticShadowObservation({ stateDirectory: "/tmp/state", sessionId, repository: { ...repository, repository_id: "../repo" }, eventSequence: 0, requestId: "req", command: read.command, result: read.result }),
    /repository identity is invalid|repository\.repository_id is invalid/i,
  );
});

test("shadow persistence refuses a missing state root instead of creating authority-like ancestry", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-shadow-missing-root-"));
  try {
    const read = readObservation();
    await assert.rejects(
      persistSemanticShadowObservation({ stateDirectory: path.join(parent, "missing"), sessionId, repository, eventSequence: 0, requestId: "req", command: read.command, result: read.result }),
      /ENOENT|receipt directory is unsafe/i,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("shadow persistence refuses a non-directory managed ancestor", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-shadow-bad-ancestor-"));
  try {
    await writeFile(path.join(stateDirectory, "bridge"), "not a directory\n", "utf8");
    const read = readObservation();
    await assert.rejects(
      persistSemanticShadowObservation({ stateDirectory, sessionId, repository, eventSequence: 0, requestId: "req", command: read.command, result: read.result }),
      /unsafe directory component|receipt directory is unsafe/i,
    );
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("shadow persistence refuses symlinked managed ancestry before any outside-state write", { skip: process.platform === "win32" }, async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-shadow-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "wco-semantic-shadow-outside-"));
  try {
    await symlink(outside, path.join(stateDirectory, "bridge"), "dir");
    const read = readObservation();
    await assert.rejects(
      persistSemanticShadowObservation({ stateDirectory, sessionId, repository, eventSequence: 0, requestId: "req", command: read.command, result: read.result }),
      /unsafe directory component|receipt directory is unsafe/i,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
