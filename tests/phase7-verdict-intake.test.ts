import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readAndCanonicalizeVerdict } from "../src/web-review/verdict-source-reader.js";
import { WebReviewError } from "../src/web-review/contracts.js";

test("INTAKE-001: readAndCanonicalizeVerdict rejects missing file", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-intake-"));
  try {
    const missingPath = path.join(tmpDir, "missing.json");
    await assert.rejects(
      () => readAndCanonicalizeVerdict(missingPath),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_SOURCE_INVALID");
        assert.ok((err as WebReviewError).message.includes("does not exist"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("INTAKE-002: readAndCanonicalizeVerdict rejects symbolic link", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-intake-"));
  try {
    const realFile = path.join(tmpDir, "real.json");
    const symlinkFile = path.join(tmpDir, "symlink.json");
    await fs.writeFile(realFile, JSON.stringify({ test: 1 }));
    await fs.symlink(realFile, symlinkFile);

    await assert.rejects(
      () => readAndCanonicalizeVerdict(symlinkFile),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_SOURCE_INVALID");
        assert.ok((err as WebReviewError).message.includes("symbolic link"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("INTAKE-003: readAndCanonicalizeVerdict rejects directory", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-intake-"));
  try {
    const dirPath = path.join(tmpDir, "subdir");
    await fs.mkdir(dirPath);

    await assert.rejects(
      () => readAndCanonicalizeVerdict(dirPath),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_SOURCE_INVALID");
        assert.ok((err as WebReviewError).message.includes("regular file"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("INTAKE-004: readAndCanonicalizeVerdict rejects oversized file (> 1 MiB)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-intake-"));
  try {
    const oversizedPath = path.join(tmpDir, "large.json");
    const bigBuffer = Buffer.alloc(1_048_577, "a"); // 1 byte over 1 MiB
    await fs.writeFile(oversizedPath, bigBuffer);

    await assert.rejects(
      () => readAndCanonicalizeVerdict(oversizedPath),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_SOURCE_INVALID");
        assert.ok((err as WebReviewError).message.includes("exceeds limit"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("INTAKE-005: readAndCanonicalizeVerdict rejects malformed JSON", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-intake-"));
  try {
    const malformedPath = path.join(tmpDir, "bad.json");
    await fs.writeFile(malformedPath, "{ invalid json content }");

    await assert.rejects(
      () => readAndCanonicalizeVerdict(malformedPath),
      (err: unknown) => {
        assert.ok(err instanceof WebReviewError);
        assert.equal((err as WebReviewError).code, "WEB_REVIEW_VERDICT_SOURCE_INVALID");
        assert.ok((err as WebReviewError).message.includes("not valid JSON"));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("INTAKE-006: readAndCanonicalizeVerdict produces deterministic canonical verdict SHA-256 regardless of formatting", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p7-intake-"));
  try {
    const obj = { b: 2, a: 1, nested: { y: "hello", x: [3, 2, 1] } };
    const path1 = path.join(tmpDir, "v1.json");
    const path2 = path.join(tmpDir, "v2.json");

    await fs.writeFile(path1, JSON.stringify(obj, null, 2));
    await fs.writeFile(path2, JSON.stringify(obj)); // compact

    const res1 = await readAndCanonicalizeVerdict(path1);
    const res2 = await readAndCanonicalizeVerdict(path2);

    assert.equal(res1.verdictSha256, res2.verdictSha256);
    assert.equal(res1.canonicalBuffer.toString("utf8"), res2.canonicalBuffer.toString("utf8"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
