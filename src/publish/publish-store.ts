import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GitPublishReceipt } from "./contracts.js";

export async function readGitPublishReceipt(
  receiptPath: string,
): Promise<GitPublishReceipt | null> {
  try {
    return JSON.parse(await readFile(receiptPath, "utf8")) as GitPublishReceipt;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  }
}

export async function writeGitPublishReceipt(
  receiptPath: string,
  receipt: GitPublishReceipt,
): Promise<void> {
  const directory = path.dirname(receiptPath);
  await mkdir(directory, { recursive: true });

  const temporaryPath = path.join(
    directory,
    `.${path.basename(receiptPath)}.${process.pid}.${Date.now()}.tmp`,
  );

  await writeFile(
    temporaryPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  await rename(temporaryPath, receiptPath);
}
