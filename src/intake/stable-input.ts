import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import { IntakeError } from "./errors.js";

/**
 * Copies bytes from one opened input file descriptor. The input pathname is
 * never read again after opening, so a later pathname replacement cannot make
 * the receipt hash describe different bytes from the quarantined source.
 */
export async function copyStableInputToQuarantine(
  inputPath: string,
  destinationPath: string,
  maximumBytes: number,
): Promise<{ bytes: number }> {
  let input: FileHandle;
  try {
    input = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new IntakeError("INPUT_SYMLINK", "Input archive must not be a symbolic link.");
    }
    throw error;
  }

  try {
    const inputInfo = await input.stat();
    if (!inputInfo.isFile()) {
      throw new IntakeError("INPUT_NOT_REGULAR_FILE", "Input archive must be a regular file.");
    }
    if (inputInfo.size > maximumBytes) {
      throw new IntakeError("ARCHIVE_TOO_LARGE", `Archive exceeds ${maximumBytes} bytes.`);
    }

    const source = createReadStream(inputPath, { fd: input.fd, autoClose: false });
    const destination = createWriteStream(destinationPath, { flags: "wx", mode: 0o600 });
    await pipeline(source, destination);

    const copiedInfo = await lstat(destinationPath);
    if (copiedInfo.isSymbolicLink() || !copiedInfo.isFile() || copiedInfo.size !== inputInfo.size) {
      throw new IntakeError("OPERATIONAL_ERROR", "Stable input copy did not match the opened archive.");
    }
    return { bytes: copiedInfo.size };
  } finally {
    await input.close();
  }
}
