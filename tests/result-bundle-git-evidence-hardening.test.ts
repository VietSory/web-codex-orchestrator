import test from "node:test";
import assert from "node:assert/strict";
import { collectGitEvidence } from "../src/result-bundle/git-evidence-reader.js";

test("P6-GIT-001 all diff paths explicitly disable external diff and textconv", async () => {
  const observed: string[][] = [];
  const runner = {
    async run(args: string[]) {
      observed.push([...args]);
      if (args.includes("--name-status")) return { stdout: "" };
      return { stdout: "" };
    },
    async runBinary(args: string[]) {
      observed.push([...args]);
      return Buffer.alloc(0);
    },
  };
  await collectGitEvidence({
    worktreePath: "/tmp/wco-git-evidence",
    baseCommit: "0".repeat(40),
    publishedCommit: "1".repeat(40),
    maximumDiffBytes: 1024,
    maximumSourceFileBytes: 1024,
    gitRunner: runner,
  });
  const diffCommands = observed.filter((args) => args.includes("diff"));
  assert.ok(diffCommands.length >= 3);
  for (const args of diffCommands) {
    assert.ok(args.includes("--no-ext-diff"));
    assert.ok(args.includes("--no-textconv"));
  }
});
