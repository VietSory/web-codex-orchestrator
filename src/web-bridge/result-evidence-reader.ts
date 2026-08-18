import crypto from "node:crypto";
import yauzl from "yauzl";
import type { ResultBundleManifest } from "../result-bundle/contracts.js";
import { WebBridgeError } from "./contracts.js";

const SELECTED = new Set([
  "RESULT.md",
  "REVIEW.md",
  "repository/diff.patch",
  "evidence/verification.json",
  "evidence/terra-review.json",
  "evidence/sol-review.json",
  "github/pull-request.json",
  "task/acceptance.json",
  "manifest.json",
]);
const MAX_ENTRY_BYTES = 4_194_304;
const MAX_AGGREGATE_BYTES = 16_777_216;
export const MAX_SEMANTIC_REVIEW_EVIDENCE_JSON_BYTES = 480 * 1024;

export interface ResultReviewEvidenceEntry {
  content_utf8: string;
  sha256: string;
  size_bytes: number;
}

export type ResultReviewEvidence = Record<string, ResultReviewEvidenceEntry>;

export function exactUtf8ReviewContent(bytes: Buffer, label = "Result evidence"): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", `${label} is not valid exact UTF-8 text.`);
  }
  return text;
}

export function assertSemanticReviewEvidenceBounded(value: unknown): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", "Semantic review evidence is not JSON-serializable.");
  }
  if (encoded === undefined) {
    throw new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", "Semantic review evidence is not JSON-serializable.");
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_SEMANTIC_REVIEW_EVIDENCE_JSON_BYTES) {
    throw new WebBridgeError(
      "WEB_RESULT_REVIEW_CONTEXT_LIMIT",
      "Exact review evidence exceeds the bounded semantic-review context. Split the change into a smaller reviewable task; WCO refuses to truncate evidence and approve from partial context.",
    );
  }
}

export async function readBoundedResultEvidence(
  archivePath: string,
  manifest: ResultBundleManifest,
): Promise<ResultReviewEvidence> {
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const result: ResultReviewEvidence = {};
  let aggregate = 0;

  await new Promise<void>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) {
        reject(new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", "Cannot open verified Result Bundle evidence."));
        return;
      }

      let settled = false;
      const fail = (value: unknown) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch {}
        reject(value);
      };

      zip.on("entry", (entry) => {
        if (!SELECTED.has(entry.fileName)) {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > MAX_ENTRY_BYTES || aggregate + entry.uncompressedSize > MAX_AGGREGATE_BYTES) {
          fail(new WebBridgeError("WEB_RESULT_EVIDENCE_LIMIT", "Selected Result evidence exceeds its byte bound."));
          return;
        }

        const bound = entry.fileName === "manifest.json" ? undefined : expected.get(entry.fileName);
        if (entry.fileName !== "manifest.json" && !bound) {
          fail(new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", "Selected Result evidence is not bound by the verified manifest."));
          return;
        }

        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", "Cannot read Result evidence entry."));
            return;
          }

          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_ENTRY_BYTES) stream.destroy(new Error("limit"));
            else chunks.push(chunk);
          });
          stream.once("error", () => fail(new WebBridgeError("WEB_RESULT_EVIDENCE_LIMIT", "Result evidence stream exceeded its bound.")));
          stream.once("end", () => {
            if (settled) return;
            const bytes = Buffer.concat(chunks, size);
            const digest = crypto.createHash("sha256").update(bytes).digest("hex");
            if (bound && (bound.sha256 !== digest || bound.size_bytes !== size)) {
              fail(new WebBridgeError("WEB_RESULT_EVIDENCE_INVALID", "Result evidence differs from the verified manifest."));
              return;
            }

            let content: string;
            try {
              content = exactUtf8ReviewContent(bytes, entry.fileName);
            } catch (decodeError) {
              fail(decodeError);
              return;
            }

            aggregate += size;
            result[entry.fileName] = { content_utf8: content, sha256: digest, size_bytes: size };
            zip.readEntry();
          });
        });
      });
      zip.once("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.once("error", fail);
      zip.readEntry();
    });
  });

  return result;
}
