import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareRepositoryResultForSemanticPrompt } from "../src/web-bridge/repository-result-semantic-context.js";

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("author RepositoryCommandResult wrapper receives the same exact UTF-8 semantic conversion as review", () => {
  const source = Buffer.from("export function caller() { return preserveInvariant(); }\n", "utf8");
  const wire = {
    request_id: "repo-author-wrapper",
    result: {
      files: [{
        path: "src/caller.ts",
        content_base64: source.toString("base64"),
        content_sha256: digest(source),
        blob_sha: "a".repeat(40),
        size_bytes: source.byteLength,
        start_byte: 0,
        end_byte_exclusive: source.byteLength,
        total_bytes: source.byteLength,
      }],
    },
  };

  const semantic = prepareRepositoryResultForSemanticPrompt(wire) as any;
  assert.equal(semantic.request_id, wire.request_id);
  assert.equal(semantic.result.files[0].content_utf8, source.toString("utf8"));
  assert.equal("content_base64" in semantic.result.files[0], false);
});

test("author wrapper still fails closed on invalid nested repository transport evidence", () => {
  const source = Buffer.from("safe\n", "utf8");
  assert.throws(
    () => prepareRepositoryResultForSemanticPrompt({
      request_id: "repo-invalid-wrapper",
      result: { files: [{ content_base64: source.toString("base64"), content_sha256: "f".repeat(64), size_bytes: source.byteLength }] },
    }),
    (error: any) => error?.code === "WEB_REPOSITORY_CONTEXT_INVALID",
  );
});

test("semantic preparation does not recursively reinterpret arbitrary nested result objects", () => {
  const source = Buffer.from("nested\n", "utf8");
  const nested = {
    request_id: "outer",
    result: {
      request_id: "inner",
      result: { files: [{ content_base64: source.toString("base64"), content_sha256: digest(source), size_bytes: source.byteLength }] },
    },
  };
  const semantic = prepareRepositoryResultForSemanticPrompt(nested) as any;
  assert.equal(semantic.result.result.files[0].content_base64, source.toString("base64"));
  assert.equal("content_utf8" in semantic.result.result.files[0], false);
});
