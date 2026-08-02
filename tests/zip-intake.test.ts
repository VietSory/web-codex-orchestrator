import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { intakeArchive } from "../src/intake/intake-service.js";
import { IntakeError } from "../src/intake/errors.js";
import { hashArchive } from "../src/intake/archive-hash.js";
import type { IntakeReceipt } from "../src/intake/contracts.js";
import {
  copyTemplate,
  makeV10Bundle,
  updateChecksums,
  writeRawZip,
  writeYazlZip,
} from "./helpers/zip-fixture.js";

async function withArchive(
  callback: (root: string, archivePath: string, stateDirectory: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "wco-intake-test-"));
  try {
    await callback(root, path.join(root, "wco-task-test.zip"), path.join(root, ".wco"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function validArchive(
  root: string,
  archivePath: string,
  wrapper?: string,
): Promise<string> {
  const bundle = await copyTemplate(root);
  await writeYazlZip(bundle, archivePath, wrapper);
  return bundle;
}

async function archiveWithTaskId(root: string, archivePath: string, taskId: string): Promise<void> {
  const bundle = await copyTemplate(root);
  const manifestPath = path.join(bundle, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.task_id = taskId;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await updateChecksums(bundle);
  await writeYazlZip(bundle, archivePath);
}

async function rejected(
  archivePath: string,
  stateDirectory: string,
  expectedCode: string,
  options?: Parameters<typeof intakeArchive>[2],
): Promise<IntakeReceipt> {
  const receipt = await intakeArchive(archivePath, stateDirectory, options);
  assert.equal(receipt.status, "rejected");
  assert.equal(receipt.errors[0]?.code, expectedCode, JSON.stringify(receipt));
  return receipt;
}

test("ZIP-001: schema 1.0 flat archive is accepted", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    const bundle = await makeV10Bundle(root);
    await writeYazlZip(bundle, archivePath);
    const receipt = await intakeArchive(archivePath, stateDirectory);
    assert.equal(receipt.status, "accepted");
    if (receipt.status === "accepted") assert.equal(receipt.bundle_schema_version, "1.0");
  });
});

test("ZIP-002: schema 1.1 wrapper archive is accepted", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    await validArchive(root, archivePath, "wco-task-207");
    const accepted = await intakeArchive(archivePath, stateDirectory);
    assert.equal(accepted.status, "accepted");
    if (accepted.status === "accepted") assert.equal(accepted.logical_root, "wco-task-207");
  });
});

test("ZIP-003/004: payload is accepted but never executed", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    const bundle = await copyTemplate(root);
    const marker = path.join(root, "marker-created-by-payload");
    const manifestPath = path.join(bundle, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.payload = { type: "apply-script", entrypoint: "payload/apply.py", review_before_execution: true };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await mkdir(path.join(bundle, "payload"), { recursive: true });
    await writeFile(path.join(bundle, "payload/apply.py"), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')\n`);
    await updateChecksums(bundle);
    await writeYazlZip(bundle, archivePath);
    const receipt = await intakeArchive(archivePath, stateDirectory);
    assert.equal(receipt.status, "accepted");
    await assert.rejects(readFile(marker));
  });
});

test("ZIP-005: truncated archive is rejected as malformed", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    await writeFile(archivePath, Buffer.from("PK\x03\x04truncated"));
    await rejected(archivePath, stateDirectory, "ZIP_MALFORMED");
    assert.deepEqual(await readdir(path.join(stateDirectory, "quarantine")), []);
  });
});

for (const [id, name] of [
  ["ZIP-006", "../escape.txt"],
  ["ZIP-007", "/tmp/escape.txt"],
  ["ZIP-008", "C:/escape.txt"],
  ["ZIP-009", "payload\\escape.txt"],
] as const) {
  test(`${id}: unsafe entry ${name}`, async () => {
    await withArchive(async (_root, archivePath, stateDirectory) => {
      await writeRawZip(archivePath, [{ name, data: Buffer.from("x") }]);
      await rejected(archivePath, stateDirectory, "ZIP_UNSAFE_PATH");
    });
  });
}

test("ZIP-010: case-insensitive path collision is rejected", async () => {
  await withArchive(async (_root, archivePath, stateDirectory) => {
    await writeRawZip(archivePath, [
      { name: "payload/File.ts", data: Buffer.from("a") },
      { name: "payload/file.ts", data: Buffer.from("b") },
    ]);
    await rejected(archivePath, stateDirectory, "ZIP_PATH_COLLISION");
  });
});

test("ZIP-011: Unicode NFC collision is rejected", async () => {
  await withArchive(async (_root, archivePath, stateDirectory) => {
    await writeRawZip(archivePath, [
      { name: "payload/e\u0301.txt", data: Buffer.from("a") },
      { name: "payload/é.txt", data: Buffer.from("b") },
    ]);
    await rejected(archivePath, stateDirectory, "ZIP_PATH_COLLISION");
  });
});

test("ZIP-012: symbolic-link entry is rejected", async () => {
  await withArchive(async (_root, archivePath, stateDirectory) => {
    await writeRawZip(archivePath, [{ name: "payload/link", data: Buffer.from("target"), externalFileAttributes: 0xa1ff0000 }]);
    await rejected(archivePath, stateDirectory, "ZIP_UNSUPPORTED_ENTRY_TYPE");
  });
});

test("ZIP-013: encrypted entry is rejected", async () => {
  await withArchive(async (_root, archivePath, stateDirectory) => {
    await writeRawZip(archivePath, [{ name: "encrypted.txt", data: Buffer.from("x"), compressedData: Buffer.alloc(13), uncompressedSize: 1, flags: 1 }]);
    await rejected(archivePath, stateDirectory, "ZIP_ENCRYPTED_ENTRY");
  });
});

test("ZIP-014: entry count limit is enforced", async () => {
  await withArchive(async (_root, archivePath, stateDirectory) => {
    await writeRawZip(archivePath, Array.from({ length: 257 }, (_, index) => ({ name: `entry-${index}.txt`, data: Buffer.from("x") })));
    await rejected(archivePath, stateDirectory, "ZIP_TOO_MANY_ENTRIES");
  });
});

test("ZIP-015/016: individual and aggregate size limits are enforced", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    await writeRawZip(archivePath, [{ name: "large.txt", data: Buffer.alloc(10) }]);
    await rejected(archivePath, stateDirectory, "ZIP_ENTRY_TOO_LARGE", { limits: { maximumEntryUncompressedBytes: 5 } });
    const second = path.join(root, "wco-task-total.zip");
    await writeRawZip(second, [
      { name: "a.txt", data: Buffer.alloc(6) },
      { name: "b.txt", data: Buffer.alloc(6) },
    ]);
    await rejected(second, stateDirectory, "ZIP_TOTAL_TOO_LARGE", { limits: { maximumTotalUncompressedBytes: 10 } });
  });
});

test("ZIP-017/018: ambiguous wrapper roots are rejected", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    await writeRawZip(archivePath, [
      { name: "one/manifest.json", data: Buffer.from("{}") },
      { name: "two/manifest.json", data: Buffer.from("{}") },
    ]);
    await rejected(archivePath, stateDirectory, "ZIP_AMBIGUOUS_ROOT");
    const second = path.join(root, "wco-task-sibling.zip");
    await writeRawZip(second, [
      { name: "one/manifest.json", data: Buffer.from("{}") },
      { name: "sibling.txt", data: Buffer.from("x") },
    ]);
    await rejected(second, stateDirectory, "ZIP_AMBIGUOUS_ROOT");
  });
});

test("ZIP-019/020: missing manifest and malformed JSON are contract failures", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    await writeRawZip(archivePath, [{ name: "README.md", data: Buffer.from("readme") }]);
    await rejected(archivePath, stateDirectory, "BUNDLE_CONTRACT_INVALID");
    const second = path.join(root, "wco-task-json.zip");
    await writeRawZip(second, [{ name: "manifest.json", data: Buffer.from("{") }]);
    await rejected(second, stateDirectory, "BUNDLE_CONTRACT_INVALID");
  });
});

test("ZIP-021: checksum mismatch is rejected", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    const bundle = await copyTemplate(root);
    await writeFile(path.join(bundle, "README.md"), "changed after signing\n");
    await writeYazlZip(bundle, archivePath);
    await rejected(archivePath, stateDirectory, "CHECKSUM_MISMATCH");
  });
});

test("ZIP-022/023: missing and unknown checksum files are rejected", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    const bundle = await copyTemplate(root);
    const checksumPath = path.join(bundle, "checksums.json");
    const checksums = JSON.parse(await readFile(checksumPath, "utf8")) as { files: Record<string, string> };
    delete checksums.files["README.md"];
    await writeFile(checksumPath, `${JSON.stringify(checksums, null, 2)}\n`);
    await writeYazlZip(bundle, archivePath);
    await rejected(archivePath, stateDirectory, "CHECKSUM_MISSING_FILE");
    const second = path.join(root, "wco-task-unknown-checksum.zip");
    checksums.files["README.md"] = "d9210d48aa2cf36e398a4d53c3502bde7364082e76883e0106d33c597523684a";
    checksums.files["does-not-exist.txt"] = "0000000000000000000000000000000000000000000000000000000000000000";
    await writeFile(checksumPath, `${JSON.stringify(checksums, null, 2)}\n`);
    await writeYazlZip(bundle, second);
    await rejected(second, stateDirectory, "CHECKSUM_UNKNOWN_FILE");
  });
});

test("ZIP-024/025/026: payload contract remains declarative", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    const bundle = await copyTemplate(root);
    const manifestPath = path.join(bundle, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.payload = { type: "apply-script", entrypoint: "README.md", review_before_execution: true };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await updateChecksums(bundle);
    await writeYazlZip(bundle, archivePath);
    await rejected(archivePath, stateDirectory, "PAYLOAD_CONTRACT_INVALID");
    const second = path.join(root, "wco-task-payload-missing.zip");
    manifest.payload = { type: "apply-script", entrypoint: "payload/apply.py", review_before_execution: true };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await updateChecksums(bundle);
    await writeYazlZip(bundle, second);
    await rejected(second, stateDirectory, "PAYLOAD_CONTRACT_INVALID");
    const third = path.join(root, "wco-task-payload-review.zip");
    manifest.payload = { type: "none", entrypoint: "payload/apply.py", review_before_execution: false };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await updateChecksums(bundle);
    await writeYazlZip(bundle, third);
    await rejected(third, stateDirectory, "PAYLOAD_CONTRACT_INVALID");
  });
});

test("ZIP-027: duplicate intake is idempotent", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    await validArchive(root, archivePath);
    const first = await intakeArchive(archivePath, stateDirectory);
    const second = await intakeArchive(archivePath, stateDirectory);
    assert.deepEqual(second, first);
    assert.deepEqual(await readdir(path.join(stateDirectory, "quarantine")), []);
  });
});

test("ZIP-028: failed extraction leaves no quarantine debris", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    let firstEntryWasWritten = false;
    await writeRawZip(archivePath, [
      { name: "first.txt", data: Buffer.from("first") },
      {
        name: "later.txt",
        data: Buffer.from("later"),
        compressionMethod: 8,
        compressedData: Buffer.from("not-a-deflate-stream"),
        uncompressedSize: 5,
      },
    ]);
    const receipt = await rejected(archivePath, stateDirectory, "ZIP_MALFORMED", {
      onFileExtracted: async (outputPath) => {
        if (path.basename(outputPath) === "first.txt") {
          firstEntryWasWritten = (await stat(outputPath)).isFile();
        }
      },
    });
    assert.equal(firstEntryWasWritten, true);
    assert.deepEqual(await readdir(path.join(stateDirectory, "quarantine")), []);
    if (!receipt.archive_sha256) assert.fail("Rejected receipt should retain the archive hash.");
    assert.deepEqual(
      (await readdir(path.join(stateDirectory, "rejected", receipt.archive_sha256))).sort(),
      ["rejection.json", "source.zip"],
    );
  });
});

test("ZIP-029: symbolic-link input is rejected before hashing", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    const real = path.join(root, "real.zip");
    await writeFile(real, Buffer.from("not used"));
    await symlink(real, archivePath);
    const receipt = await intakeArchive(archivePath, stateDirectory);
    assert.equal(receipt.status, "rejected");
    assert.equal(receipt.errors[0]?.code, "INPUT_SYMLINK");
  });
});

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("src/cli/index.ts"), ...args], {
      cwd: path.resolve("."),
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("ZIP-030: --json prints one receipt object", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    await validArchive(root, archivePath);
    const result = await runCli(["intake", archivePath, "--state-dir", stateDirectory, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim().startsWith("{"), true);
    assert.equal((JSON.parse(result.stdout) as { status: string }).status, "accepted");
  });
});

test("ZIP-031/032/033: CLI exit codes are stable", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    await writeFile(archivePath, Buffer.from("bad"));
    const rejectedResult = await runCli(["intake", archivePath, "--state-dir", stateDirectory]);
    assert.equal(rejectedResult.code, 1);
    const usageResult = await runCli(["intake"]);
    assert.equal(usageResult.code, 2);
    const stateFile = path.join(root, "state-file");
    await writeFile(stateFile, "file");
    const operationalResult = await runCli(["intake", archivePath, "--state-dir", stateFile]);
    assert.equal(operationalResult.code, 3);
  });
});

test("ZIP-034/035: directory validation and Phase 1 behavior remain available", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    const bundle = await validArchive(root, archivePath);
    const direct = await import("../src/bundle/validator.js");
    const report = await direct.validateBundleDirectory(bundle);
    assert.equal(report.ok, true);
    await rm(stateDirectory, { recursive: true, force: true });
  });
});

for (const [id, taskId] of [
  ["ZIP-036", "."],
  ["ZIP-037", ".."],
  ["ZIP-038", "a".repeat(129)],
] as const) {
  test(`${id}: unsafe task ID is rejected before accepted storage`, async () => {
    await withArchive(async (root, archivePath, stateDirectory) => {
      await archiveWithTaskId(root, archivePath, taskId);
      await rejected(archivePath, stateDirectory, "BUNDLE_CONTRACT_INVALID");
      assert.deepEqual(await readdir(path.join(stateDirectory, "accepted")), []);
    });
  });
}

for (const [id, lifecycle] of [
  ["ZIP-039", "accepted"],
  ["ZIP-040", "rejected"],
  ["ZIP-041", "quarantine"],
] as const) {
  test(`${id}: lifecycle-directory symlink is operationally rejected`, async () => {
    await withArchive(async (root, archivePath, stateDirectory) => {
      await validArchive(root, archivePath);
      const target = path.join(root, `${lifecycle}-target`);
      await mkdir(stateDirectory, { recursive: true });
      await mkdir(target);
      await symlink(target, path.join(stateDirectory, lifecycle));
      await assert.rejects(
        intakeArchive(archivePath, stateDirectory),
        (error: unknown) => error instanceof IntakeError && error.code === "OPERATIONAL_ERROR",
      );
    });
  });
}

test("lifecycle-directory regular files are operationally rejected", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    await validArchive(root, archivePath);
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(path.join(stateDirectory, "accepted"), "not a directory");
    await assert.rejects(
      intakeArchive(archivePath, stateDirectory),
      (error: unknown) => error instanceof IntakeError && error.code === "OPERATIONAL_ERROR",
    );
  });
});

test("ZIP-042: receipt hash describes the stable quarantined source after input replacement", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    await validArchive(root, archivePath);
    const replacementRoot = path.join(root, "replacement");
    const replacementBundle = await copyTemplate(replacementRoot);
    const manifestPath = path.join(replacementBundle, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.task_id = "TASK-REPLACED";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await updateChecksums(replacementBundle);
    const replacementArchive = path.join(root, "replacement.zip");
    await writeYazlZip(replacementBundle, replacementArchive);

    const receipt = await intakeArchive(archivePath, stateDirectory, {
      beforeQuarantineCopy: async () => {
        await rm(archivePath);
        await rename(replacementArchive, archivePath);
      },
    });
    assert.equal(receipt.status, "accepted");
    if (receipt.status !== "accepted") return;
    assert.equal(receipt.task_id, "TASK-REPLACED");
    const source = path.join(stateDirectory, "accepted", receipt.task_id, receipt.archive_sha256, "source.zip");
    assert.equal(await hashArchive(source), receipt.archive_sha256);
  });
});

for (const [id, entry, expectedCode] of [
  ["ZIP-043", { name: "CON.txt", data: Buffer.from("x") }, "ZIP_UNSAFE_PATH"],
  ["ZIP-044", { name: "payload/file.", data: Buffer.from("x") }, "ZIP_UNSAFE_PATH"],
  ["ZIP-045", { name: "payload/file ", data: Buffer.from("x") }, "ZIP_UNSAFE_PATH"],
  ["ZIP-046", { name: "x".repeat(241), data: Buffer.from("x") }, "ZIP_UNSAFE_PATH"],
  ["ZIP-047", { name: `payload/${"x".repeat(101)}`, data: Buffer.from("x") }, "ZIP_UNSAFE_PATH"],
  ["ZIP-048", { name: "unsupported.bin", data: Buffer.from("x"), compressionMethod: 12 }, "ZIP_UNSUPPORTED_COMPRESSION"],
  ["ZIP-049", { name: "fifo", data: Buffer.from("x"), externalFileAttributes: 0x11a40000 }, "ZIP_UNSUPPORTED_ENTRY_TYPE"],
] as const) {
  test(`${id}: ZIP entry policy rejects ${entry.name}`, async () => {
    await withArchive(async (_root, archivePath, stateDirectory) => {
      await writeRawZip(archivePath, [entry]);
      await rejected(archivePath, stateDirectory, expectedCode);
    });
  });
}

test("ZIP-050/051: ancestor and duplicate paths are policy collisions", async () => {
  await withArchive(async (root, archivePath, stateDirectory) => {
    await writeRawZip(archivePath, [
      { name: "a", data: Buffer.from("file") },
      { name: "a/b", data: Buffer.from("descendant") },
    ]);
    await rejected(archivePath, stateDirectory, "ZIP_PATH_COLLISION");
    const duplicate = path.join(root, "wco-task-duplicate.zip");
    await writeRawZip(duplicate, [
      { name: "same.txt", data: Buffer.from("first") },
      { name: "same.txt", data: Buffer.from("second") },
    ]);
    await rejected(duplicate, stateDirectory, "ZIP_PATH_COLLISION");
  });
});
