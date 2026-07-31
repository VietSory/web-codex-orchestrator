import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateBundleDirectory } from "../src/bundle/validator.js";

const templateDirectory = path.resolve("templates/task-bundle");

async function withBundle(
  callback: (bundleDirectory: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "wco-test-"));
  const bundleDirectory = path.join(root, "bundle");
  await cp(templateDirectory, bundleDirectory, { recursive: true });

  try {
    await callback(bundleDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("valid example bundle passes", async () => {
  await withBundle(async (bundleDirectory) => {
    const report = await validateBundleDirectory(bundleDirectory);
    assert.equal(report.ok, true, report.errors.join("\n"));
  });
});

test("missing required file fails", async () => {
  await withBundle(async (bundleDirectory) => {
    await rm(path.join(bundleDirectory, "rules.md"));
    const report = await validateBundleDirectory(bundleDirectory);

    assert.equal(report.ok, false);
    assert.ok(report.errors.some((item) => item.includes("rules.md")));
  });
});

test("dangerous validation command fails", async () => {
  await withBundle(async (bundleDirectory) => {
    const filePath = path.join(bundleDirectory, "validation.json");
    const document = JSON.parse(await readFile(filePath, "utf8")) as {
      commands: Array<{ command: string }>;
    };

    document.commands[0]!.command = "npm test && git push";
    await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`);

    const report = await validateBundleDirectory(bundleDirectory);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((item) => item.includes("Shell operators")));
  });
});
