import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareRepositoryResultForSemanticPrompt } from "../src/web-bridge/repository-result-semantic-context.js";

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("exact UTF-8 repository reads become readable semantic context without base64 expansion", () => {
  const source = Buffer.from("export function healthStatus() { return 'ok'; }\n", "utf8");
  const wire = {
    files: [{
      path: "src/health.ts",
      content_base64: source.toString("base64"),
      content_sha256: digest(source),
      blob_sha: "a".repeat(40),
      size_bytes: source.byteLength,
      start_byte: 0,
      end_byte_exclusive: source.byteLength,
      total_bytes: source.byteLength,
    }],
  };

  const semantic = prepareRepositoryResultForSemanticPrompt(wire) as any;
  assert.equal(semantic.files[0].content_utf8, source.toString("utf8"));
  assert.equal("content_base64" in semantic.files[0], false);
  assert.ok(
    Buffer.byteLength(JSON.stringify(semantic), "utf8") < Buffer.byteLength(JSON.stringify(wire), "utf8"),
    "semantic UTF-8 representation must be smaller than the exact base64 wire representation",
  );
});

test("content-addressed repository cache hits do not retransmit an empty payload", () => {
  const semantic = prepareRepositoryResultForSemanticPrompt({
    files: [{
      path: "src/health.ts",
      content_base64: "",
      content_ref: `sha256:${"b".repeat(64)}`,
      content_sha256: "b".repeat(64),
      blob_sha: "a".repeat(40),
      size_bytes: 128,
      start_byte: 0,
      end_byte_exclusive: 128,
      total_bytes: 128,
    }],
  }) as any;
  assert.equal(semantic.files[0].content_ref, `sha256:${"b".repeat(64)}`);
  assert.equal("content_base64" in semantic.files[0], false);
});

test("repository semantic context fails closed when transport evidence is not exact", () => {
  const source = Buffer.from("safe\n", "utf8");
  assert.throws(
    () => prepareRepositoryResultForSemanticPrompt({ files: [{ content_base64: source.toString("base64"), content_sha256: "c".repeat(64), size_bytes: source.byteLength }] }),
    (error: any) => error?.code === "WEB_REPOSITORY_CONTEXT_INVALID",
  );
  assert.throws(
    () => prepareRepositoryResultForSemanticPrompt({ files: [{ content_base64: "not base64!", content_sha256: digest(source), size_bytes: source.byteLength }] }),
    (error: any) => error?.code === "WEB_REPOSITORY_CONTEXT_INVALID",
  );
});

test("non-UTF8 repository bytes remain binary-safe instead of being lossy-decoded", () => {
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
  const encoded = binary.toString("base64");
  const semantic = prepareRepositoryResultForSemanticPrompt({ files: [{ content_base64: encoded, content_sha256: digest(binary), size_bytes: binary.byteLength }] }) as any;
  assert.equal(semantic.files[0].content_base64, encoded);
  assert.equal("content_utf8" in semantic.files[0], false);
});
