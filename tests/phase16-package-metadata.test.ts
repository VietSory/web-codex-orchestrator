import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

function normalizeBin(value: unknown): Record<string, string> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([name, target]): [string, string] => {
        assert.equal(typeof target, "string");
        return [name, String(target).replace(/^\.\//, "")];
      })
      .sort((left, right) => left[0].localeCompare(right[0])),
  );
}

test("P16-PACKAGE-001 package-lock root bin metadata matches package.json exactly", async () => {
  const root = process.cwd();
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { bin?: unknown };
  const packageLock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { bin?: unknown }>;
  };

  const expected = normalizeBin(packageJson.bin);
  const locked = normalizeBin(packageLock.packages?.[""]?.bin);

  assert.deepEqual(Object.keys(expected).sort(), [
    "wco",
    "wco-control",
    "wco-executor",
    "wco-web-authority",
  ]);
  assert.deepEqual(locked, expected);
});
