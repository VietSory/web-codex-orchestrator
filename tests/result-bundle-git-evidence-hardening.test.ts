import test from "node:test";
import assert from "node:assert/strict";
import { collectGitEvidence } from "../src/result-bundle/git-evidence-reader.js";
import { ResultBundleError } from "../src/result-bundle/contracts.js";

const base = "0".repeat(40);
const published = "1".repeat(40);

function options(gitRunner: Parameters<typeof collectGitEvidence>[0]["gitRunner"], overrides: Partial<Parameters<typeof collectGitEvidence>[0]> = {}) {
  return {
    worktreePath: "/tmp/wco-result-git-evidence",
    baseCommit: base,
    publishedCommit: published,
    maximumDiffBytes: 1024,
    maximumSourceFileBytes: 1024,
    gitRunner,
    ...overrides,
  };
}

test("RESULT-GIT-HARDEN-001 all diff inspection paths disable external diff and textconv", async () => {
  const observed: string[][] = [];
  const runner = {
    async run(args: string[]) {
      observed.push([...args]);
      return { stdout: "" };
    },
    async runBinary(args: string[]) {
      observed.push([...args]);
      return Buffer.alloc(0);
    },
  };

  await collectGitEvidence(options(runner));
  const diffCommands = observed.filter((args) => args.includes("diff"));
  assert.ok(diffCommands.length >= 3);
  for (const args of diffCommands) {
    assert.ok(args.includes("--no-ext-diff"));
    assert.ok(args.includes("--no-textconv"));
    assert.ok(args.includes("--"));
  }
});

test("RESULT-GIT-HARDEN-002 mode attestation is option-safe, literal, and fails closed", async () => {
  const observed: string[][] = [];
  const runner = {
    async run(args: string[]) {
      observed.push([...args]);
      if (args.includes("--name-status")) return { stdout: "M\0-leading-*-[dash].txt\0" };
      if (args.includes("ls-tree")) return { stdout: "" };
      return { stdout: "" };
    },
    async runBinary(args: string[]) {
      observed.push([...args]);
      if (args.includes("show")) return Buffer.from("payload");
      return Buffer.alloc(0);
    },
  };

  await assert.rejects(
    () => collectGitEvidence(options(runner)),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_GIT_INSPECTION_FAILED",
  );
  const lsTree = observed.find((args) => args.includes("ls-tree"));
  assert.ok(lsTree);
  assert.ok(lsTree!.includes("--literal-pathspecs"));
  assert.deepEqual(lsTree!.slice(-2), ["--", "-leading-*-[dash].txt"]);
});

test("RESULT-GIT-HARDEN-003 symlink and special Git modes never fall back to regular-file mode", async () => {
  const runner = {
    async run(args: string[]) {
      if (args.includes("--name-status")) return { stdout: "M\0link.txt\0" };
      if (args.includes("ls-tree")) return { stdout: `120000 blob ${"2".repeat(40)}\tlink.txt\n` };
      return { stdout: "" };
    },
    async runBinary(args: string[]) {
      if (args.includes("show")) return Buffer.from("target");
      return Buffer.alloc(0);
    },
  };

  await assert.rejects(
    () => collectGitEvidence(options(runner)),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_UNSUPPORTED_CHANGE_TYPE",
  );
});

test("RESULT-GIT-HARDEN-004 clean diff independently obeys the configured diff byte cap", async () => {
  let diffCalls = 0;
  const runner = {
    async run(args: string[]) {
      if (args.includes("--name-status")) return { stdout: "" };
      return { stdout: "" };
    },
    async runBinary(args: string[]) {
      if (args.includes("diff")) {
        diffCalls += 1;
        return diffCalls === 1 ? Buffer.from("small") : Buffer.alloc(33, 0x61);
      }
      return Buffer.alloc(0);
    },
  };

  await assert.rejects(
    () => collectGitEvidence(options(runner, { maximumDiffBytes: 32, maximumSourceFileBytes: 1024 })),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_ARCHIVE_SIZE_LIMIT",
  );
});

test("RESULT-GIT-HARDEN-005 mode attestation rejects multiple records instead of choosing one", async () => {
  const runner = {
    async run(args: string[]) {
      if (args.includes("--name-status")) return { stdout: "M\0literal*.txt\0" };
      if (args.includes("ls-tree")) return { stdout: `100644 blob ${"2".repeat(40)}\tliteral-a.txt\n100755 blob ${"3".repeat(40)}\tliteral-b.txt\n` };
      return { stdout: "" };
    },
    async runBinary(args: string[]) {
      if (args.includes("show")) return Buffer.from("payload");
      return Buffer.alloc(0);
    },
  };

  await assert.rejects(
    () => collectGitEvidence(options(runner)),
    (error: unknown) => error instanceof ResultBundleError && error.code === "RESULT_GIT_INSPECTION_FAILED",
  );
});
