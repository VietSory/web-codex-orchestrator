import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateBundleDirectory } from "../src/bundle/validator.js";
import { copyTemplate } from "./helpers/zip-fixture.js";

async function withBundle(callback: (bundleDirectory: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "wco-validator-test-"));
  try {
    await callback(await copyTemplate(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("valid schema 1.1 example bundle passes", async () => {
  await withBundle(async (bundleDirectory) => {
    const report = await validateBundleDirectory(bundleDirectory);
    assert.equal(report.ok, true, report.errors.join("\n"));
  });
});

test("missing required schema 1.1 file fails", async () => {
  await withBundle(async (bundleDirectory) => {
    await rm(path.join(bundleDirectory, "RULES.md"));
    const report = await validateBundleDirectory(bundleDirectory);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((item) => item.includes("RULES.md")));
  });
});

test("schema 1.0 directory contract remains backward compatible", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wco-v10-test-"));
  const bundle = path.join(root, "bundle");
  try {
    await cp(path.resolve("templates/task-bundle"), bundle, { recursive: true });
    const manifestPath = path.join(bundle, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.schema_version = "1.0";
    delete manifest.payload;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    for (const [from, to] of [
      ["README.md", "readme.md"], ["REQUEST.md", "request.md"], ["RESEARCH.md", "research.md"],
      ["SOURCES.md", "sources.md"], ["PLAN.md", "plan.md"], ["RULES.md", "rules.md"], ["VALIDATION.md", "validation.md"],
    ] as const) {
      await cp(path.join(bundle, from), path.join(bundle, to));
      await rm(path.join(bundle, from));
    }
    await rm(path.join(bundle, "checksums.json"));
    const report = await validateBundleDirectory(bundle);
    assert.equal(report.ok, true, report.errors.join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dangerous validation command fails with a structured contract issue", async () => {
  await withBundle(async (bundleDirectory) => {
    const filePath = path.join(bundleDirectory, "validation.json");
    const document = JSON.parse(await readFile(filePath, "utf8")) as {
      commands: Array<{ command: string }>;
    };
    document.commands[0]!.command = "npm test && git push";
    await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`);
    const report = await validateBundleDirectory(bundleDirectory);
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((issue) => issue.code === "BUNDLE_CONTRACT_INVALID"));
    assert.ok(report.errors.some((item) => item.includes("Shell operators")));
  });
});
