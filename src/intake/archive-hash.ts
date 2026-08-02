import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

/** Streams the archive; it never loads the archive into memory. */
export async function hashArchive(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
