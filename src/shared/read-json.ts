import { createReadStream } from "node:fs";

export class FileTooLargeForJsonError extends Error {
  constructor(readonly maximumBytes: number) {
    super(`JSON file exceeds the ${maximumBytes} byte safety limit.`);
    this.name = "FileTooLargeForJsonError";
  }
}

/**
 * Reads small metadata JSON with a strict cap. Archive payload files are never
 * read through this helper; they are always streamed by the intake service.
 */
export async function readJsonFile(
  filePath: string,
  maximumBytes = 1 * 1024 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) {
      throw new FileTooLargeForJsonError(maximumBytes);
    }
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
