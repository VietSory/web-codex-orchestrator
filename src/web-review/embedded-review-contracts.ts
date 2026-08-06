import crypto from "node:crypto";
import yauzl from "yauzl";
import Ajv2020Mod from "ajv/dist/2020.js";
import { WebReviewError } from "./contracts.js";
import type { ResultBundleReceipt } from "../result-bundle/contracts.js";

const Ajv2020 = (Ajv2020Mod as any).default ?? Ajv2020Mod;

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export const REQUIRED_REVIEW_BUNDLE_ENTRIES = [
  "manifest.json",
  "task/acceptance.json",
  "task/test-matrix.json",
  "task/validation.json",
  "task/risk-policy.json",
  "task/spec-lock.json",
  "review/WEB-REVIEW-CONTRACT.md",
  "review/web-review-policy.json",
  "review/web-review-verdict.schema.json",
  "review/revision-request.schema.json",
] as const;

export const MAX_ENTRY_BYTES = 2 * 1024 * 1024; // 2 MiB per entry
export const MAX_AGGREGATE_BYTES = 10 * 1024 * 1024; // 10 MiB aggregate

export interface LoadedEmbeddedContracts {
  entries: Map<string, Buffer>;
  manifest: any;
  acceptance: any;
  testMatrix: any;
  validation: any;
  riskPolicy: any;
  specLock: any;
  reviewContractMd: string;
  reviewPolicy: any;
  verdictSchemaObj: any;
  revisionRequestSchemaObj: any;
  compiledVerdictValidator: (data: unknown) => boolean;
  compiledRevisionRequestValidator: (data: unknown) => boolean;
  verdictSchemaErrors: () => string | null;
  revisionRequestSchemaErrors: () => string | null;
}

/**
 * Selective, bounded reading of embedded review contract files from Result Bundle ZIP (P0-03, P1-01).
 * Hashes exact entry bytes, cross-checks against Phase 6 receipt and manifest, and compiles schema validators.
 */
export async function loadEmbeddedReviewContracts(
  archivePath: string,
  receipt: ResultBundleReceipt
): Promise<LoadedEmbeddedContracts> {
  const entriesMap = new Map<string, Buffer>();
  let aggregateBytes = 0;

  await new Promise<void>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) {
        return reject(
          new WebReviewError(
            "WEB_REVIEW_RESULT_BUNDLE_INVALID",
            `Failed to open Result Bundle ZIP at ${archivePath}: ${err?.message ?? "unknown error"}`
          )
        );
      }

      zipfile.on("entry", (entry: yauzl.Entry) => {
        const entryName = entry.fileName;
        if (REQUIRED_REVIEW_BUNDLE_ENTRIES.includes(entryName as any)) {
          if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
            zipfile.close();
            return reject(
              new WebReviewError(
                "WEB_REVIEW_RESULT_BUNDLE_INVALID",
                `ZIP entry '${entryName}' uncompressed size ${entry.uncompressedSize} bytes exceeds per-entry limit ${MAX_ENTRY_BYTES} bytes`
              )
            );
          }

          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr || !readStream) {
              zipfile.close();
              return reject(
                new WebReviewError(
                  "WEB_REVIEW_RESULT_BUNDLE_INVALID",
                  `Failed to read ZIP entry '${entryName}': ${streamErr?.message}`
                )
              );
            }

            const chunks: Buffer[] = [];
            let entryBytes = 0;

            readStream.on("data", (chunk: Buffer) => {
              entryBytes += chunk.length;
              aggregateBytes += chunk.length;

              if (entryBytes > MAX_ENTRY_BYTES || aggregateBytes > MAX_AGGREGATE_BYTES) {
                readStream.destroy();
                zipfile.close();
                return reject(
                  new WebReviewError(
                    "WEB_REVIEW_RESULT_BUNDLE_INVALID",
                    `Reading entry '${entryName}' exceeded byte caps`
                  )
                );
              }
              chunks.push(chunk);
            });

            readStream.on("end", () => {
              entriesMap.set(entryName, Buffer.concat(chunks));
              zipfile.readEntry();
            });

            readStream.on("error", (rErr) => {
              zipfile.close();
              reject(
                new WebReviewError(
                  "WEB_REVIEW_RESULT_BUNDLE_INVALID",
                  `Stream error reading entry '${entryName}': ${rErr.message}`
                )
              );
            });
          });
        } else {
          zipfile.readEntry();
        }
      });

      zipfile.on("end", () => resolve());
      zipfile.on("error", (zErr) =>
        reject(
          new WebReviewError(
            "WEB_REVIEW_RESULT_BUNDLE_INVALID",
            `ZIP error: ${zErr.message}`
          )
        )
      );

      zipfile.readEntry();
    });
  });

  // Verify all required entries were found
  for (const requiredEntry of REQUIRED_REVIEW_BUNDLE_ENTRIES) {
    if (!entriesMap.has(requiredEntry)) {
      throw new WebReviewError(
        "WEB_REVIEW_RESULT_BUNDLE_INVALID",
        `Result Bundle is missing required review entry '${requiredEntry}'`
      );
    }
  }

  // Strictly parse JSON entries
  const parseJsonEntry = (name: string) => {
    try {
      return JSON.parse(entriesMap.get(name)!.toString("utf8"));
    } catch (e) {
      throw new WebReviewError(
        "WEB_REVIEW_RESULT_BUNDLE_INVALID",
        `Malformed JSON in bundle entry '${name}': ${e instanceof Error ? e.message : String(e)}`
      );
    }
  };

  const manifest = parseJsonEntry("manifest.json");
  const acceptance = parseJsonEntry("task/acceptance.json");
  const testMatrix = parseJsonEntry("task/test-matrix.json");
  const validation = parseJsonEntry("task/validation.json");
  const riskPolicy = parseJsonEntry("task/risk-policy.json");
  const specLock = parseJsonEntry("task/spec-lock.json");
  const reviewPolicy = parseJsonEntry("review/web-review-policy.json");
  const verdictSchemaObj = parseJsonEntry("review/web-review-verdict.schema.json");
  const revisionRequestSchemaObj = parseJsonEntry("review/revision-request.schema.json");
  const reviewContractMd = entriesMap.get("review/WEB-REVIEW-CONTRACT.md")!.toString("utf8");

  // Verify manifest hashes match Phase 6 receipt
  const manifestSha = sha256Hex(entriesMap.get("manifest.json")!);
  if (receipt.manifest_sha256 && manifestSha !== receipt.manifest_sha256) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Bundle manifest SHA256 '${manifestSha}' does not match Phase 6 receipt '${receipt.manifest_sha256}'`
    );
  }

  // Cross-check entry hashes against manifest.entries
  if (Array.isArray(manifest.entries)) {
    const manifestMap = new Map<string, string>();
    for (const e of manifest.entries) {
      if (e && typeof e.path === "string" && typeof e.sha256 === "string") {
        manifestMap.set(e.path, e.sha256);
      }
    }

    for (const requiredEntry of REQUIRED_REVIEW_BUNDLE_ENTRIES) {
      if (requiredEntry === "manifest.json") continue;
      const expectedSha = manifestMap.get(requiredEntry);
      if (!expectedSha) {
        throw new WebReviewError(
          "WEB_REVIEW_RESULT_BUNDLE_INVALID",
          `Required entry '${requiredEntry}' is not listed in manifest.entries`
        );
      }
      const actualSha = sha256Hex(entriesMap.get(requiredEntry)!);
      if (actualSha !== expectedSha) {
        throw new WebReviewError(
          "WEB_REVIEW_RESULT_BUNDLE_INVALID",
          `Checksum mismatch for entry '${requiredEntry}': calculated '${actualSha}', manifest specifies '${expectedSha}'`
        );
      }
    }
  }

  // Compile Ajv validators for embedded schemas
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  let verdictValidate: any;
  let verdictErrorsText: string | null = null;
  try {
    verdictValidate = ajv.compile(verdictSchemaObj);
  } catch (e) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Failed to compile embedded verdict schema: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  let revReqValidate: any;
  let revReqErrorsText: string | null = null;
  try {
    revReqValidate = ajv.compile(revisionRequestSchemaObj);
  } catch (e) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Failed to compile embedded revision request schema: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const compiledVerdictValidator = (data: unknown): boolean => {
    const valid = verdictValidate(data);
    if (!valid) {
      verdictErrorsText = ajv.errorsText(verdictValidate.errors);
    } else {
      verdictErrorsText = null;
    }
    return valid;
  };

  const compiledRevisionRequestValidator = (data: unknown): boolean => {
    const valid = revReqValidate(data);
    if (!valid) {
      revReqErrorsText = ajv.errorsText(revReqValidate.errors);
    } else {
      revReqErrorsText = null;
    }
    return valid;
  };

  return {
    entries: entriesMap,
    manifest,
    acceptance,
    testMatrix,
    validation,
    riskPolicy,
    specLock,
    reviewContractMd,
    reviewPolicy,
    verdictSchemaObj,
    revisionRequestSchemaObj,
    compiledVerdictValidator,
    compiledRevisionRequestValidator,
    verdictSchemaErrors: () => verdictErrorsText,
    revisionRequestSchemaErrors: () => revReqErrorsText,
  };
}
