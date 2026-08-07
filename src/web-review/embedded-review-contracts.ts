import crypto from "node:crypto";
import yauzl from "yauzl";
import Ajv2020Mod from "ajv/dist/2020.js";
import { WebReviewError } from "./contracts.js";
import type { ResultBundleReceipt } from "../result-bundle/contracts.js";

const Ajv2020 = (Ajv2020Mod as any).default ?? Ajv2020Mod;

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function requireSha256(label: string, value: string | null): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Phase 6 receipt is missing valid ${label}`
    );
  }
  return value;
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
 * Selective, bounded reading of embedded review contract files from Result Bundle ZIP.
 * Every authoritative review/spec artifact is hash-bound to the independently
 * verified manifest and, where Phase 6 provides a named receipt binding, to the
 * Phase 6 receipt as well.
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

      let settled = false;
      const fail = (error: WebReviewError) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch { /* best effort */ }
        reject(error);
      };

      zipfile.on("entry", (entry: yauzl.Entry) => {
        const entryName = entry.fileName;
        if (!REQUIRED_REVIEW_BUNDLE_ENTRIES.includes(entryName as any)) {
          zipfile.readEntry();
          return;
        }
        if (entriesMap.has(entryName)) {
          return fail(new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", `Duplicate required ZIP entry '${entryName}'`));
        }
        if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
          return fail(
            new WebReviewError(
              "WEB_REVIEW_RESULT_BUNDLE_INVALID",
              `ZIP entry '${entryName}' uncompressed size ${entry.uncompressedSize} bytes exceeds per-entry limit ${MAX_ENTRY_BYTES} bytes`
            )
          );
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            return fail(
              new WebReviewError(
                "WEB_REVIEW_RESULT_BUNDLE_INVALID",
                `Failed to read ZIP entry '${entryName}': ${streamErr?.message ?? "unknown error"}`
              )
            );
          }

          const chunks: Buffer[] = [];
          let entryBytes = 0;
          readStream.on("data", (chunk: Buffer) => {
            entryBytes += chunk.length;
            aggregateBytes += chunk.length;
            if (entryBytes > MAX_ENTRY_BYTES || aggregateBytes > MAX_AGGREGATE_BYTES) {
              readStream.destroy(
                new WebReviewError(
                  "WEB_REVIEW_RESULT_BUNDLE_INVALID",
                  `Reading entry '${entryName}' exceeded bounded review byte caps`
                )
              );
              return;
            }
            chunks.push(chunk);
          });
          readStream.on("end", () => {
            if (settled) return;
            entriesMap.set(entryName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
          readStream.on("error", (rErr) => {
            fail(
              rErr instanceof WebReviewError
                ? rErr
                : new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", `Stream error reading entry '${entryName}': ${rErr.message}`)
            );
          });
        });
      });

      zipfile.on("end", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      zipfile.on("error", (zErr) =>
        fail(new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", `ZIP error: ${zErr.message}`))
      );
      zipfile.readEntry();
    });
  });

  for (const requiredEntry of REQUIRED_REVIEW_BUNDLE_ENTRIES) {
    if (!entriesMap.has(requiredEntry)) {
      throw new WebReviewError(
        "WEB_REVIEW_RESULT_BUNDLE_INVALID",
        `Result Bundle is missing required review entry '${requiredEntry}'`
      );
    }
  }

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

  const manifestReceiptSha = requireSha256("manifest_sha256", receipt.manifest_sha256);
  const manifestSha = sha256Hex(entriesMap.get("manifest.json")!);
  if (manifestSha !== manifestReceiptSha) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      `Manifest SHA mismatch: calculated '${manifestSha}', Phase 6 receipt specifies '${manifestReceiptSha}'`
    );
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !Array.isArray(manifest.entries)) {
    throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", "Result Bundle manifest.entries is missing or invalid");
  }

  const manifestMap = new Map<string, string>();
  for (const e of manifest.entries) {
    if (!e || typeof e.path !== "string" || typeof e.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.sha256)) {
      throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", "Result Bundle manifest contains an invalid entry descriptor");
    }
    if (manifestMap.has(e.path)) {
      throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", `Result Bundle manifest contains duplicate entry '${e.path}'`);
    }
    manifestMap.set(e.path, e.sha256);
  }

  for (const requiredEntry of REQUIRED_REVIEW_BUNDLE_ENTRIES) {
    if (requiredEntry === "manifest.json") continue;
    const expectedSha = manifestMap.get(requiredEntry);
    if (!expectedSha) {
      throw new WebReviewError("WEB_REVIEW_RESULT_BUNDLE_INVALID", `Required entry '${requiredEntry}' is not listed in manifest.entries`);
    }
    const actualSha = sha256Hex(entriesMap.get(requiredEntry)!);
    if (actualSha !== expectedSha) {
      throw new WebReviewError(
        "WEB_REVIEW_RESULT_BUNDLE_INVALID",
        `Checksum mismatch for entry '${requiredEntry}': calculated '${actualSha}', manifest specifies '${expectedSha}'`
      );
    }
  }

  const namedBindings = [
    {
      label: "review_contract_sha256",
      path: "review/WEB-REVIEW-CONTRACT.md",
      receiptValue: requireSha256("review_contract_sha256", receipt.review_contract_sha256),
      manifestValue: manifest.review_contract_sha256,
    },
    {
      label: "review_policy_sha256",
      path: "review/web-review-policy.json",
      receiptValue: requireSha256("review_policy_sha256", receipt.review_policy_sha256),
      manifestValue: manifest.review_policy_sha256,
    },
    {
      label: "verdict_schema_sha256",
      path: "review/web-review-verdict.schema.json",
      receiptValue: requireSha256("verdict_schema_sha256", receipt.verdict_schema_sha256),
      manifestValue: manifest.verdict_schema_sha256,
    },
    {
      label: "revision_request_schema_sha256",
      path: "review/revision-request.schema.json",
      receiptValue: requireSha256("revision_request_schema_sha256", receipt.revision_request_schema_sha256),
      manifestValue: manifest.revision_request_schema_sha256,
    },
  ] as const;

  for (const binding of namedBindings) {
    const actualSha = sha256Hex(entriesMap.get(binding.path)!);
    if (actualSha !== binding.receiptValue) {
      throw new WebReviewError(
        "WEB_REVIEW_RESULT_BUNDLE_INVALID",
        `${binding.label} does not match exact embedded '${binding.path}' bytes`
      );
    }
    if (binding.manifestValue !== binding.receiptValue) {
      throw new WebReviewError(
        "WEB_REVIEW_RESULT_BUNDLE_INVALID",
        `Manifest ${binding.label} does not match Phase 6 receipt`
      );
    }
  }

  const specSetSha = requireSha256("spec_set_sha256", receipt.spec_set_sha256);
  if (manifest.spec_set_sha256 !== specSetSha || specLock?.spec_set_sha256 !== specSetSha) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      "spec_set_sha256 does not match across Phase 6 receipt, Result Bundle manifest and task/spec-lock.json"
    );
  }
  const reviewedEntrySetSha = requireSha256("reviewed_entry_set_sha256", receipt.reviewed_entry_set_sha256);
  if (manifest.reviewed_entry_set_sha256 !== reviewedEntrySetSha) {
    throw new WebReviewError(
      "WEB_REVIEW_RESULT_BUNDLE_INVALID",
      "Manifest reviewed_entry_set_sha256 does not match Phase 6 receipt"
    );
  }

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
    verdictErrorsText = valid ? null : ajv.errorsText(verdictValidate.errors);
    return valid;
  };
  const compiledRevisionRequestValidator = (data: unknown): boolean => {
    const valid = revReqValidate(data);
    revReqErrorsText = valid ? null : ajv.errorsText(revReqValidate.errors);
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
