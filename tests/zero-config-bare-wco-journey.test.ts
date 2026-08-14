import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runInteractiveApp } from "../src/tui/interactive-app.js";
import type { InteractiveIo } from "../src/tui/session.js";

const run = promisify(execFile);

function scriptedIo(answers: string[], output: string[]): InteractiveIo {
  return {
    input: process.stdin,
    output: process.stdout,
    write: (value) => output.push(value),
    question: async () => answers.shift() ?? "/quit",
    close: () => undefined,
  };
}

test("fresh bare wco auto-sets up zero-config local mode and returning launch does not repeat setup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-bare-user-journey-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await run("git", ["init", "-b", "main", repo]);
  await run("git", ["config", "user.name", "WCO User Journey"], { cwd: repo });
  await run("git", ["config", "user.email", "journey@example.invalid"], { cwd: repo });
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "journey", private: true, scripts: { test: "node --test" } }));
  await writeFile(path.join(repo, "app.txt"), "before\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-m", "base"], { cwd: repo });

  const previousHome = process.env.WCO_HOME;
  const previousCi = process.env.CI;
  const previousCwd = process.cwd();
  process.env.WCO_HOME = home;
  process.env.CI = "true";
  process.chdir(repo);
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.WCO_HOME; else process.env.WCO_HOME = previousHome;
    if (previousCi === undefined) delete process.env.CI; else process.env.CI = previousCi;
  });

  const firstOutput: string[] = [];
  assert.equal(await runInteractiveApp(scriptedIo(["/quit"], firstOutput)), 0);
  const firstText = firstOutput.join("");
  assert.match(firstText, /Welcome to WCO/);
  assert.match(firstText, /local ChatGPT\/Codex \(zero-config default\)/);
  assert.match(firstText, /Web Codex Orchestrator · v0\.3/);

  const configPath = path.join(home, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.web_bridge, undefined);
  assert.equal(config.runtime?.source, "bundled");
  assert.equal(Object.keys(config.repositories ?? {}).length, 1);

  const configBefore = await readFile(configPath, "utf8");
  const secondOutput: string[] = [];
  assert.equal(await runInteractiveApp(scriptedIo(["/quit"], secondOutput)), 0);
  assert.doesNotMatch(secondOutput.join(""), /Welcome to WCO/);
  assert.equal(await readFile(configPath, "utf8"), configBefore, "returning bare wco must reuse trusted setup byte-for-byte");
});
