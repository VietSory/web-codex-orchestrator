import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export class SafeDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeDirectoryError";
  }
}

async function attestDirectory(directory: string, label: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) {
    throw new SafeDirectoryError(`${label} contains an unsafe directory component: ${directory}`);
  }
}

/**
 * Create an absolute directory one path component at a time. Every existing or
 * newly created component is lstat/realpath-attested before the next child can
 * be created, and the parent is re-attested around a missing-child creation.
 * This intentionally avoids recursive mkdir through untrusted symlink ancestry.
 */
export async function ensureCanonicalDirectory(value: string, label = "managed path"): Promise<string> {
  const absolute = path.resolve(value);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  await attestDirectory(current, label);

  for (const segment of path.relative(parsed.root, absolute).split(path.sep).filter(Boolean)) {
    const parent = current;
    current = path.join(current, segment);
    let exists = true;
    try { await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    if (!exists) {
      await attestDirectory(parent, label);
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await attestDirectory(parent, label);
    }
    await attestDirectory(current, label);
  }
  return absolute;
}
