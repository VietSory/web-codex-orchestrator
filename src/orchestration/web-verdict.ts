import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IngestedVerdict } from "../web-review/verdict-source-reader.js";
import { submitWebVerdict } from "../web-review/web-review-service.js";
import type { WebReviewReceipt } from "../web-review/contracts.js";
import { OrchestrationError } from "./contracts.js";

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export async function submitAttestedWebVerdict(options: {
  runId: string;
  stateDirectory: string;
  configPath: string;
  ingestedVerdict: IngestedVerdict;
  now?: () => Date;
}): Promise<WebReviewReceipt> {
  const { ingestedVerdict } = options;
  if (sha256Hex(ingestedVerdict.canonicalBuffer) !== ingestedVerdict.verdictSha256) {
    throw new OrchestrationError("ORCHESTRATION_WEB_VERDICT_DRIFT", "Canonical Web verdict bytes no longer match the sealed digest.");
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wco-web-verdict-"));
  const verdictPath = path.join(directory, "verdict.json");
  try {
    await fs.chmod(directory, 0o700).catch(() => undefined);
    await fs.writeFile(verdictPath, ingestedVerdict.canonicalBuffer, { flag: "wx", mode: 0o600 });
    const receipt = await submitWebVerdict({
      runId: options.runId,
      stateDirectory: options.stateDirectory,
      configPath: options.configPath,
      verdictPath,
      ...(options.now ? { now: options.now } : {}),
    });
    if (receipt.verdict_sha256 !== ingestedVerdict.verdictSha256) {
      throw new OrchestrationError("ORCHESTRATION_WEB_VERDICT_DRIFT", "Web review service sealed a verdict digest different from the orchestration attempt.");
    }
    return receipt;
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
