import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCodexRuntime } from "../../src/runtime/codex-runtime.js";
import { CodexVerificationSandbox } from "../../src/verifier/codex-sandbox.js";
import { BubblewrapVerificationSandbox } from "../../src/verifier/bubblewrap-sandbox.js";

const enabled = process.env.WCO_RUN_SANDBOX_INTEGRATION === "1";

test(
  "P4-110: bundled Codex sandbox denies loopback without host fallback",
  { skip: !enabled },
  async (context) => {
    if (!enabled) {
      context.skip("WCO_RUN_SANDBOX_INTEGRATION is not enabled.");
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "wco-real-sandbox-"));
    const cwd = path.join(root, "worktree");
    const marker = path.join(cwd, "child-started.txt");

    await mkdir(cwd, { recursive: true });

    let connected = false;
    const server = createServer((socket) => {
      connected = true;
      socket.end();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Loopback server did not expose a TCP port.");
      }

      const runtime = await resolveCodexRuntime(
        {
          source: "bundled",
          ...(process.env.WCO_CODEX_HOME
            ? { codex_home: process.env.WCO_CODEX_HOME }
            : {}),
        },
        root,
      );
      const sandbox = new CodexVerificationSandbox(runtime);
      await sandbox.checkAvailability();

      const script = [
        "const fs = require('node:fs');",
        "const net = require('node:net');",
        "fs.writeFileSync(process.env.WCO_TEST_MARKER, 'STARTED');",
        "const socket = net.createConnection({",
        "  host: '127.0.0.1',",
        "  port: Number(process.argv[1]),",
        "});",
        "socket.setTimeout(1500, () => process.exit(2));",
        "socket.on('connect', () => process.exit(0));",
        "socket.on('error', () => process.exit(2));",
      ].join("\n");

      const result = await sandbox.run(
        "node",
        ["-e", script, String(address.port)],
        {
          cwd,
          env: { WCO_TEST_MARKER: marker },
          timeoutMs: 5000,
          maximumOutputBytes: 8192,
          network_access: false,
          writable_root: root,
          credential_directories: [],
        },
      );

      assert.notEqual(result.exitCode, 0);
      assert.equal(await readFile(marker, "utf8"), "STARTED");
      assert.equal(connected, false);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "Harness Bubblewrap sandbox supports the host Node runtime while denying loopback",
  { skip: !enabled },
  async (context) => {
    if (!enabled) {
      context.skip("WCO_RUN_SANDBOX_INTEGRATION is not enabled.");
      return;
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "wco-real-harness-sandbox-"));
    const marker = path.join(root, "child-started.txt");
    let connected = false;
    const server = createServer((socket) => { connected = true; socket.end(); });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Loopback server did not expose a TCP port.");

      const sandbox = new BubblewrapVerificationSandbox();
      await sandbox.checkAvailability();
      const script = [
        "const fs = require('node:fs');",
        "const net = require('node:net');",
        "fs.writeFileSync(process.env.WCO_TEST_MARKER, 'STARTED');",
        "const socket = net.createConnection({ host: '127.0.0.1', port: Number(process.argv[1]) });",
        "socket.setTimeout(1500, () => process.exit(2));",
        "socket.on('connect', () => process.exit(0));",
        "socket.on('error', () => process.exit(2));",
      ].join("\n");
      const result = await sandbox.run("node", ["-e", script, String(address.port)], {
        cwd: root,
        env: { WCO_TEST_MARKER: marker },
        timeoutMs: 5000,
        maximumOutputBytes: 8192,
        network_access: false,
        writable_root: root,
        credential_directories: [],
      });

      assert.notEqual(result.exitCode, 0);
      assert.equal(await readFile(marker, "utf8"), "STARTED");
      assert.equal(connected, false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
