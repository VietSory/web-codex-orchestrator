import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  browserCompanionInstallMetadataPath,
  ensureWcoBrowserCompanionInstalled,
} from "../src/setup/browser-companion-bootstrap.js";

function response(body: Buffer | string, status = 200) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => name.toLowerCase() === "content-length" ? String(bytes.length) : null },
    async arrayBuffer(): Promise<ArrayBuffer> { return Uint8Array.from(bytes).buffer; },
    async text(): Promise<string> { return bytes.toString("utf8"); },
  };
}

async function writeInstallation(executable: string, version: string, binary: Buffer, metadataSha?: string): Promise<string> {
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, binary);
  const sha256 = metadataSha ?? crypto.createHash("sha256").update(binary).digest("hex");
  await writeFile(browserCompanionInstallMetadataPath(executable), `${JSON.stringify({
    schema_version: 1,
    version,
    sha256,
    asset: "wco-browser-companion-windows-x64.exe",
    repository: "VietSory/web-codex-orchestrator",
  })}\n`, "utf8");
  return sha256;
}

function releaseFetcher(binary: Buffer) {
  const sha256 = crypto.createHash("sha256").update(binary).digest("hex");
  let calls = 0;
  return {
    get calls() { return calls; },
    fetch: async (url: string) => {
      calls += 1;
      return url.endsWith(".sha256")
        ? response(`${sha256}  wco-browser-companion-windows-x64.exe\n`)
        : response(binary);
    },
  };
}

test("exact installed companion is reused only after version and SHA provenance verification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-installed-provenance-"));
  try {
    const executable = path.join(root, "wco-browser-companion.exe");
    const binary = Buffer.from("qualified-current-companion");
    const sha256 = await writeInstallation(executable, "9.8.7", binary);
    let fetched = false;
    const installed = await ensureWcoBrowserCompanionInstalled({
      env: {},
      installPath: executable,
      packageVersion: "9.8.7",
      fetch: async () => { fetched = true; return response("unexpected"); },
    });
    assert.deepEqual(installed, { executable, source: "installed", version: "9.8.7", sha256 });
    assert.equal(fetched, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale installed companion is replaced from the exact current-version release assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-installed-stale-"));
  try {
    const executable = path.join(root, "wco-browser-companion.exe");
    await writeInstallation(executable, "9.8.6", Buffer.from("stale-companion"));
    const current = Buffer.from("current-companion");
    const source = releaseFetcher(current);
    const installed = await ensureWcoBrowserCompanionInstalled({
      env: {},
      installPath: executable,
      packageVersion: "9.8.7",
      fetch: source.fetch,
    });
    assert.equal(installed.source, "downloaded");
    assert.equal(installed.version, "9.8.7");
    assert.equal(source.calls, 2);
    assert.deepEqual(await readFile(executable), current);
    const metadata = JSON.parse(await readFile(browserCompanionInstallMetadataPath(executable), "utf8")) as Record<string, unknown>;
    assert.equal(metadata.version, "9.8.7");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tampered installed companion is never trusted even when metadata claims the current version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-installed-tampered-"));
  try {
    const executable = path.join(root, "wco-browser-companion.exe");
    const trusted = Buffer.from("trusted-companion");
    const trustedSha = crypto.createHash("sha256").update(trusted).digest("hex");
    await writeInstallation(executable, "9.8.7", Buffer.from("tampered-companion"), trustedSha);
    const source = releaseFetcher(trusted);
    const installed = await ensureWcoBrowserCompanionInstalled({
      env: {},
      installPath: executable,
      packageVersion: "9.8.7",
      fetch: source.fetch,
    });
    assert.equal(installed.source, "downloaded");
    assert.equal(source.calls, 2);
    assert.deepEqual(await readFile(executable), trusted);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
