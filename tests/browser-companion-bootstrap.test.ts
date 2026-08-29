import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    headers: {
      get(name: string) {
        return name.toLowerCase() === "content-length" ? String(bytes.length) : null;
      },
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      return Uint8Array.from(bytes).buffer;
    },
    async text(): Promise<string> {
      return bytes.toString("utf8");
    },
  };
}

test("explicit companion executable is the only CI transport escape hatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-bootstrap-explicit-"));
  try {
    const executable = path.join(root, "fake-companion.exe");
    await writeFile(executable, "fake");
    let fetched = false;
    const installed = await ensureWcoBrowserCompanionInstalled({
      env: { CI: "true", WCO_CHATGPT_WEB_COMPANION_EXECUTABLE: executable },
      fetch: async () => { fetched = true; return response("unexpected"); },
    });
    assert.equal(installed.source, "explicit");
    assert.equal(installed.executable, executable);
    assert.equal(fetched, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CI refuses an already-installed default companion and never fetches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-bootstrap-ci-"));
  try {
    const executable = path.join(root, "already-installed.exe");
    await writeFile(executable, "real-user-transport-placeholder");
    let fetched = false;
    await assert.rejects(
      ensureWcoBrowserCompanionInstalled({
        env: { CI: "true" },
        installPath: executable,
        fetch: async () => { fetched = true; return response("unexpected"); },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "WEB_CHATGPT_COMPANION_BOOTSTRAP_DISABLED");
        return true;
      },
    );
    assert.equal(fetched, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap downloads exact WCO-version assets, verifies SHA-256 and writes provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-bootstrap-download-"));
  try {
    const executable = path.join(root, "browser", "wco-browser-companion.exe");
    const binary = Buffer.from("first-party-wco-browser-companion", "utf8");
    const sha256 = crypto.createHash("sha256").update(binary).digest("hex");
    const urls: string[] = [];
    const installed = await ensureWcoBrowserCompanionInstalled({
      env: {},
      installPath: executable,
      packageVersion: "9.8.7-test.1",
      fetch: async (url) => {
        urls.push(url);
        return url.endsWith(".sha256")
          ? response(`${sha256}  wco-browser-companion-windows-x64.exe\n`)
          : response(binary);
      },
    });

    assert.equal(installed.source, "downloaded");
    assert.equal(installed.version, "9.8.7-test.1");
    assert.equal(installed.sha256, sha256);
    assert.deepEqual(await readFile(executable), binary);
    assert.deepEqual(urls.sort(), [
      "https://github.com/VietSory/web-codex-orchestrator/releases/download/v9.8.7-test.1/wco-browser-companion-windows-x64.exe",
      "https://github.com/VietSory/web-codex-orchestrator/releases/download/v9.8.7-test.1/wco-browser-companion-windows-x64.exe.sha256",
    ].sort());

    const metadata = JSON.parse(await readFile(browserCompanionInstallMetadataPath(executable), "utf8")) as Record<string, unknown>;
    assert.equal(metadata.version, "9.8.7-test.1");
    assert.equal(metadata.sha256, sha256);
    assert.equal(metadata.repository, "VietSory/web-codex-orchestrator");
    assert.equal(metadata.asset, "wco-browser-companion-windows-x64.exe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checksum mismatch fails closed without installing the target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-bootstrap-sha-"));
  try {
    const executable = path.join(root, "browser", "wco-browser-companion.exe");
    const binary = Buffer.from("tampered-companion", "utf8");
    await assert.rejects(
      ensureWcoBrowserCompanionInstalled({
        env: {},
        installPath: executable,
        packageVersion: "9.8.7-test.1",
        fetch: async (url) => url.endsWith(".sha256")
          ? response(`${"0".repeat(64)}  wco-browser-companion-windows-x64.exe\n`)
          : response(binary),
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "WEB_CHATGPT_COMPANION_CHECKSUM_MISMATCH");
        return true;
      },
    );
    assert.equal(existsSync(executable), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
