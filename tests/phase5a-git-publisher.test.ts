import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  GitPublishError,
  type GitCommandResult,
  type GitCommandRunner,
  type GitPublishReceipt,
  type GitPublishRequest,
  type VerifiedChangeSet,
} from "../src/publish/contracts.js";
import { GitPublisher } from "../src/publish/git-publisher.js";
import {
  readGitPublishReceipt,
  writeGitPublishReceipt,
} from "../src/publish/publish-store.js";

class TestGitRunner implements GitCommandRunner {
  constructor(private readonly hooksPath: string) {}

  run(args: readonly string[], cwd: string): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "git",
        [
          "-c",
          `core.hooksPath=${this.hooksPath}`,
          "-c",
          "credential.helper=",
          "-c",
          "protocol.file.allow=always",
          ...args,
        ],
        {
          cwd,
          shell: false,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: cwd,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
            GIT_AUTHOR_NAME: "WCO Phase 5A Test",
            GIT_AUTHOR_EMAIL: "wco-phase5a@example.invalid",
            GIT_COMMITTER_NAME: "WCO Phase 5A Test",
            GIT_COMMITTER_EMAIL: "wco-phase5a@example.invalid",
          },
        },
      );

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        resolve({ exitCode: exitCode ?? 1, stdout, stderr, signal });
      });
    });
  }
}

async function requireGit(
  runner: GitCommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await runner.run(args, cwd);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function inspectFixtureChangeSet(
  runner: GitCommandRunner,
  cwd: string,
  paths: readonly string[],
): Promise<VerifiedChangeSet> {
  const digest = createHash("sha256");

  for (const relativePath of [...paths].sort()) {
    digest.update(relativePath);
    digest.update("\u0000");
    digest.update(await readFile(path.join(cwd, relativePath)));
    digest.update("\u0000");
  }

  const status = await requireGit(
    runner,
    cwd,
    ["status", "--porcelain=v1", "--untracked-files=all"],
  );
  digest.update(status);

  return {
    change_set_sha256: digest.digest("hex"),
    paths: [...paths],
  };
}

interface Fixture {
  root: string;
  worktree: string;
  remote: string;
  runner: TestGitRunner;
  baseCommit: string;
  branchName: string;
  receiptPath: string;
  cleanup(): Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wco-phase5a-"));
  const worktree = path.join(root, "worktree");
  const remote = path.join(root, "remote.git");
  const hooks = path.join(root, "empty-hooks");
  const receiptPath = path.join(root, "state", "publish.json");
  await mkdir(worktree, { recursive: true });
  await mkdir(hooks, { recursive: true });
  await chmod(hooks, 0o700);

  const runner = new TestGitRunner(hooks);
  await requireGit(runner, root, ["init", "--bare", remote]);
  await requireGit(runner, worktree, ["init"]);
  await writeFile(path.join(worktree, "README.md"), "base\n", "utf8");
  await requireGit(runner, worktree, ["add", "README.md"]);
  await requireGit(runner, worktree, ["commit", "-m", "base"]);
  const baseCommit = await requireGit(runner, worktree, ["rev-parse", "HEAD"]);
  const branchName = "codex/phase-5a-fixture";
  await requireGit(runner, worktree, ["switch", "-c", branchName]);
  await requireGit(runner, worktree, ["remote", "add", "origin", remote]);

  return {
    root,
    worktree,
    remote,
    runner,
    baseCommit,
    branchName,
    receiptPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function request(
  fixture: Fixture,
  changeSet: VerifiedChangeSet,
): GitPublishRequest {
  return {
    run_id: "TASK-PHASE5A:test",
    worktree_path: fixture.worktree,
    base_commit: fixture.baseCommit,
    branch_name: fixture.branchName,
    remote_name: "origin",
    allowed_remote_url: fixture.remote,
    allowed_branch_prefix: "codex/",
    deny_direct_push_branches: ["main", "master"],
    expected_change_set_sha256: changeSet.change_set_sha256,
    expected_paths: changeSet.paths,
    commit_message: "Publish verified Phase 5A fixture",
    allow_force_push: false,
    allow_remote_branch_delete: false,
  };
}

test("P5A-001: commit and push the exact attested change set to a new branch", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "verified\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );

    const publisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: () =>
        inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]),
      persistReceipt: (receipt) =>
        writeGitPublishReceipt(fixture.receiptPath, receipt),
    });

    const receipt = await publisher.publish(request(fixture, changeSet));
    assert.equal(receipt.state, "PUSHED");
    assert.ok(receipt.commit_sha);
    assert.equal(receipt.commit_sha, receipt.remote_branch_sha);
    assert.equal(
      await requireGit(fixture.runner, fixture.worktree, ["rev-parse", "HEAD^"]),
      fixture.baseCommit,
    );
    assert.equal(
      await requireGit(fixture.runner, fixture.worktree, [
        "ls-remote",
        "--heads",
        "origin",
        `refs/heads/${fixture.branchName}`,
      ]).then((line) => line.split(/\s+/)[0]),
      receipt.commit_sha,
    );
    assert.deepEqual(await readGitPublishReceipt(fixture.receiptPath), receipt);
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-002: a stale digest fails before staging or committing", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "approved\n", "utf8");
    const approved = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );
    await writeFile(path.join(fixture.worktree, "feature.txt"), "tampered\n", "utf8");

    const publisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: () =>
        inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]),
      persistReceipt: async () => undefined,
    });

    await assert.rejects(
      () => publisher.publish(request(fixture, approved)),
      (error: unknown) =>
        error instanceof GitPublishError &&
        error.code === "PUBLISH_CHANGE_SET_STALE",
    );

    assert.equal(
      await requireGit(fixture.runner, fixture.worktree, ["rev-parse", "HEAD"]),
      fixture.baseCommit,
    );
    assert.equal(
      await requireGit(fixture.runner, fixture.worktree, ["diff", "--cached", "--name-only"]),
      "",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-003: direct pushes and force-push capability are rejected locally", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "verified\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );
    const valid = request(fixture, changeSet);
    const publisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: async () => changeSet,
      persistReceipt: async () => undefined,
    });

    await assert.rejects(
      () => publisher.publish({ ...valid, branch_name: "main" }),
      (error: unknown) =>
        error instanceof GitPublishError &&
        error.code === "PUBLISH_BRANCH_POLICY_VIOLATION",
    );

    await assert.rejects(
      () => publisher.publish({ ...valid, allow_force_push: true } as never),
      (error: unknown) =>
        error instanceof GitPublishError &&
        error.code === "PUBLISH_REQUEST_INVALID",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-004: retrying a PUSHED receipt is idempotent", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "verified\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );
    let latestReceipt: GitPublishReceipt | null = null;
    const publisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: () =>
        inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]),
      persistReceipt: async (receipt) => { latestReceipt = structuredClone(receipt); },
    });

    const first = await publisher.publish(request(fixture, changeSet));
    const before = await requireGit(fixture.runner, fixture.worktree, ["rev-list", "--count", "HEAD"]);
    const second = await publisher.publish(
      request(fixture, changeSet),
      structuredClone(latestReceipt ?? first),
    );
    const after = await requireGit(fixture.runner, fixture.worktree, ["rev-list", "--count", "HEAD"]);

    assert.deepEqual(second, first);
    assert.equal(before, after);
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-005: an unexpected existing remote branch is never overwritten", async () => {
  const fixture = await createFixture();

  try {
    await requireGit(fixture.runner, fixture.worktree, [
      "push",
      "origin",
      `${fixture.baseCommit}:refs/heads/${fixture.branchName}`,
    ]);
    await writeFile(path.join(fixture.worktree, "feature.txt"), "verified\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );
    const publisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: async () => changeSet,
      persistReceipt: async () => undefined,
    });

    await assert.rejects(
      () => publisher.publish(request(fixture, changeSet)),
      (error: unknown) =>
        error instanceof GitPublishError &&
        error.code === "PUBLISH_REMOTE_BRANCH_EXISTS",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-006: a persisted COMMITTED receipt resumes with one non-force push", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "verified\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );

    let failPush = true;
    const failOnceRunner: GitCommandRunner = {
      run: async (args, cwd) => {
        if (args[0] === "push" && !args.includes("--dry-run") && failPush) {
          failPush = false;
          return {
            exitCode: 1,
            stdout: "",
            stderr: "simulated bounded push failure",
          };
        }

        return fixture.runner.run(args, cwd);
      },
    };

    let persisted: GitPublishReceipt | null = null;
    const firstPublisher = new GitPublisher({
      runner: failOnceRunner,
      inspectVerifiedChangeSet: () =>
        inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]),
      persistReceipt: async (receipt) => { persisted = structuredClone(receipt); },
    });

    await assert.rejects(
      () => firstPublisher.publish(request(fixture, changeSet)),
      (error: unknown) =>
        error instanceof GitPublishError &&
        error.code === "PUBLISH_PUSH_FAILED",
    );

    assert.ok(persisted);
    assert.equal((persisted as GitPublishReceipt).state, "COMMITTED");
    assert.ok((persisted as GitPublishReceipt).commit_sha);

    const secondPublisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: async () => {
        throw new Error("A COMMITTED resume must not re-inspect an already committed worktree.");
      },
      persistReceipt: async (receipt) => { persisted = structuredClone(receipt); },
    });

    const completed = await secondPublisher.publish(
      request(fixture, changeSet),
      structuredClone(persisted as GitPublishReceipt),
    );

    assert.equal(completed.state, "PUSHED");
    assert.equal(completed.commit_sha, completed.remote_branch_sha);
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-007: a mutation between attestation and git add is rejected by the index snapshot", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "approved\n", "utf8");
    const approved = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );
    let mutated = false;
    const racingRunner: GitCommandRunner = {
      run: async (args, cwd) => {
        if (!mutated && args.includes("add")) {
          mutated = true;
          await writeFile(path.join(cwd, "feature.txt"), "raced\n", "utf8");
        }
        return fixture.runner.run(args, cwd);
      },
    };

    const publisher = new GitPublisher({
      runner: racingRunner,
      inspectVerifiedChangeSet: () =>
        inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]),
      persistReceipt: (receipt) =>
        writeGitPublishReceipt(fixture.receiptPath, receipt),
    });

    await assert.rejects(
      () => publisher.publish(request(fixture, approved)),
      (error: unknown) =>
        error instanceof GitPublishError &&
        error.code === "PUBLISH_INDEX_MISMATCH",
    );

    assert.equal(
      await requireGit(fixture.runner, fixture.worktree, ["rev-parse", "HEAD"]),
      fixture.baseCommit,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-008: a crash after commit but before COMMITTED persistence recovers exactly one commit", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "verified\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );
    let persisted: GitPublishReceipt | null = null;
    let persistCount = 0;

    const firstPublisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: () =>
        inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]),
      persistReceipt: async (receipt) => {
        persistCount += 1;
        if (persistCount === 2) throw new Error("simulated receipt crash");
        persisted = structuredClone(receipt);
      },
    });

    await assert.rejects(
      () => firstPublisher.publish(request(fixture, changeSet)),
      /simulated receipt crash/,
    );

    assert.ok(persisted);
    assert.equal((persisted as GitPublishReceipt).state, "READY_FOR_COMMIT");
    const committedHead = await requireGit(
      fixture.runner,
      fixture.worktree,
      ["rev-parse", "HEAD"],
    );
    assert.notEqual(committedHead, fixture.baseCommit);

    const secondPublisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: async () => {
        throw new Error("Recovery must use the durable approved snapshot, not a clean worktree diff.");
      },
      persistReceipt: async (receipt) => {
        persisted = structuredClone(receipt);
      },
    });

    const completed = await secondPublisher.publish(
      request(fixture, changeSet),
      structuredClone(persisted as GitPublishReceipt),
    );

    assert.equal(completed.state, "PUSHED");
    assert.equal(completed.commit_sha, committedHead);
    assert.equal(
      await requireGit(fixture.runner, fixture.worktree, ["rev-list", "--count", "HEAD"]),
      "2",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-009: a crash after push but before PUSHED persistence resumes without a second commit", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "verified\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );
    let persisted: GitPublishReceipt | null = null;

    const firstPublisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: () =>
        inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]),
      persistReceipt: async (receipt) => {
        if (receipt.state === "PUSHED") throw new Error("simulated pushed receipt crash");
        persisted = structuredClone(receipt);
      },
    });

    await assert.rejects(
      () => firstPublisher.publish(request(fixture, changeSet)),
      /simulated pushed receipt crash/,
    );

    assert.ok(persisted);
    assert.equal((persisted as GitPublishReceipt).state, "COMMITTED");
    const before = await requireGit(
      fixture.runner,
      fixture.worktree,
      ["rev-list", "--count", "HEAD"],
    );

    const secondPublisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: async () => {
        throw new Error("A COMMITTED resume must not inspect a now-clean worktree.");
      },
      persistReceipt: async (receipt) => {
        persisted = structuredClone(receipt);
      },
    });

    const completed = await secondPublisher.publish(
      request(fixture, changeSet),
      structuredClone(persisted as GitPublishReceipt),
    );
    const after = await requireGit(
      fixture.runner,
      fixture.worktree,
      ["rev-list", "--count", "HEAD"],
    );

    assert.equal(completed.state, "PUSHED");
    assert.equal(before, after);
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-010: an unapproved commit cannot be adopted during READY receipt recovery", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "approved\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );
    let persisted: GitPublishReceipt | null = null;
    const stopBeforeAdd: GitCommandRunner = {
      run: async (args, cwd) => {
        if (args.includes("add")) {
          return { exitCode: 1, stdout: "", stderr: "stop before add" };
        }
        return fixture.runner.run(args, cwd);
      },
    };
    const firstPublisher = new GitPublisher({
      runner: stopBeforeAdd,
      inspectVerifiedChangeSet: () =>
        inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]),
      persistReceipt: async (receipt) => {
        persisted = structuredClone(receipt);
      },
    });

    await assert.rejects(
      () => firstPublisher.publish(request(fixture, changeSet)),
      (error: unknown) =>
        error instanceof GitPublishError &&
        error.code === "PUBLISH_COMMIT_FAILED",
    );
    assert.ok(persisted);
    assert.equal((persisted as GitPublishReceipt).state, "READY_FOR_COMMIT");

    await writeFile(path.join(fixture.worktree, "feature.txt"), "unapproved\n", "utf8");
    await requireGit(fixture.runner, fixture.worktree, ["add", "feature.txt"]);
    await requireGit(
      fixture.runner,
      fixture.worktree,
      ["commit", "-m", "Publish verified Phase 5A fixture"],
    );

    const recoveryPublisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: async () => changeSet,
      persistReceipt: async () => undefined,
    });

    await assert.rejects(
      () => recoveryPublisher.publish(
        request(fixture, changeSet),
        structuredClone(persisted as GitPublishReceipt),
      ),
      (error: unknown) =>
        error instanceof GitPublishError &&
        error.code === "PUBLISH_RECOVERY_FAILED",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-011: malformed or legacy publish receipts fail closed", async () => {
  const fixture = await createFixture();

  try {
    await mkdir(path.dirname(fixture.receiptPath), { recursive: true });
    await writeFile(
      fixture.receiptPath,
      JSON.stringify({ publish_version: "1.0", state: "COMMITTED" }),
      "utf8",
    );

    await assert.rejects(
      () => readGitPublishReceipt(fixture.receiptPath),
      (error: unknown) =>
        error instanceof GitPublishError &&
        error.code === "PUBLISH_RECEIPT_INVALID",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-014: a READY receipt resumes from an exact staged index after a pre-commit crash", async () => {
  const fixture = await createFixture();

  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "verified\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(
      fixture.runner,
      fixture.worktree,
      ["feature.txt"],
    );
    let persisted: GitPublishReceipt | null = null;
    let failCommit = true;
    const failCommitOnceRunner: GitCommandRunner = {
      run: async (args, cwd) => {
        if (args[0] === "commit" && failCommit) {
          failCommit = false;
          return {
            exitCode: 1,
            stdout: "",
            stderr: "simulated crash after staging",
          };
        }

        return fixture.runner.run(args, cwd);
      },
    };

    const firstPublisher = new GitPublisher({
      runner: failCommitOnceRunner,
      inspectVerifiedChangeSet: () =>
        inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]),
      persistReceipt: async (receipt) => {
        persisted = structuredClone(receipt);
      },
    });

    await assert.rejects(
      () => firstPublisher.publish(request(fixture, changeSet)),
      (error: unknown) =>
        error instanceof GitPublishError &&
        error.code === "PUBLISH_COMMIT_FAILED",
    );

    assert.ok(persisted);
    assert.equal((persisted as GitPublishReceipt).state, "READY_FOR_COMMIT");
    assert.equal(
      await requireGit(fixture.runner, fixture.worktree, [
        "diff",
        "--cached",
        "--name-only",
      ]),
      "feature.txt",
    );

    const secondPublisher = new GitPublisher({
      runner: fixture.runner,
      inspectVerifiedChangeSet: async () => {
        throw new Error(
          "Staged recovery must use the durable approved index snapshot.",
        );
      },
      persistReceipt: async (receipt) => {
        persisted = structuredClone(receipt);
      },
    });

    const completed = await secondPublisher.publish(
      request(fixture, changeSet),
      structuredClone(persisted as GitPublishReceipt),
    );

    assert.equal(completed.state, "PUSHED");
    assert.equal(completed.commit_sha, completed.remote_branch_sha);
    assert.equal(
      await requireGit(fixture.runner, fixture.worktree, [
        "rev-list",
        "--count",
        "HEAD",
      ]),
      "2",
    );
  } finally {
    await fixture.cleanup();
  }
});

test(
  "P5A-015: core.fileMode=false ignores unreliable executable filesystem bits",
  async () => {
    const fixture = await createFixture();

    try {
      await requireGit(
        fixture.runner,
        fixture.worktree,
        ["config", "core.fileMode", "false"],
      );

      const featurePath = path.join(
        fixture.worktree,
        "feature.txt",
      );

      await writeFile(
        featurePath,
        "verified on a filesystem with unreliable modes\n",
        "utf8",
      );

      await chmod(featurePath, 0o777);

      const fileInfo = await import(
        "node:fs/promises"
      ).then(({ stat }) => stat(featurePath));

      assert.notEqual(
        fileInfo.mode & 0o111,
        0,
        "The fixture must have executable bits on the filesystem.",
      );

      const changeSet = await inspectFixtureChangeSet(
        fixture.runner,
        fixture.worktree,
        ["feature.txt"],
      );

      const publisher = new GitPublisher({
        runner: fixture.runner,
        inspectVerifiedChangeSet: () =>
          inspectFixtureChangeSet(
            fixture.runner,
            fixture.worktree,
            ["feature.txt"],
          ),
        persistReceipt: (receipt) =>
          writeGitPublishReceipt(
            fixture.receiptPath,
            receipt,
          ),
      });

      const receipt = await publisher.publish(
        request(fixture, changeSet),
      );

      assert.equal(receipt.state, "PUSHED");

      const treeEntry = await requireGit(
        fixture.runner,
        fixture.worktree,
        [
          "ls-tree",
          "HEAD",
          "--",
          "feature.txt",
        ],
      );

      assert.match(
        treeEntry,
        /^100644 blob [0-9a-f]{40,64}\tfeature\.txt$/,
      );

      assert.equal(
        await requireGit(
          fixture.runner,
          fixture.worktree,
          [
            "ls-remote",
            "--heads",
            "origin",
            `refs/heads/${fixture.branchName}`,
          ],
        ).then((line) => line.split(/\s+/)[0]),
        receipt.commit_sha,
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

test("P5A-021: dry-run preflight blocking bad authentication early", async () => {
  const fixture = await createFixture();
  try {
    const originalRun = fixture.runner.run.bind(fixture.runner);
    let realPushCount = 0;
    fixture.runner.run = async (args, cwd) => {
      if (args[0] === "push" && !args.includes("--dry-run")) realPushCount++;
      if (args.includes("--dry-run")) {
        return { exitCode: 1, stdout: "", stderr: "403 Forbidden", executable: "git", args, cwd, duration_ms: 10 };
      }
      return originalRun(args, cwd);
    };
    await writeFile(path.join(fixture.worktree, "feature.txt"), "test\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]);
    let savedReceipt: any = null;
    const publisher = new GitPublisher({ runner: fixture.runner, inspectVerifiedChangeSet: async () => changeSet, persistReceipt: async (r) => { savedReceipt = r; } });
    await assert.rejects(publisher.publish(request(fixture, changeSet)), { code: "PUBLISH_AUTH_FAILED" });
    
    assert.equal(savedReceipt?.state, "READY_FOR_COMMIT");
    assert.equal(realPushCount, 0, "Should not reach real push");
    const head = await originalRun(["rev-parse", "HEAD"], fixture.worktree);
    assert.equal(head.stdout.trim(), fixture.baseCommit, "HEAD should remain at base");
    const commits = await originalRun(["rev-list", "--count", "HEAD"], fixture.worktree);
    assert.equal(commits.stdout.trim(), "1", "No product commit should be created");
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-022: racing remote branch creation detected before real push", async () => {
  const fixture = await createFixture();
  try {
    const originalRun = fixture.runner.run.bind(fixture.runner);
    const pushArgv: string[][] = [];
    fixture.runner.run = async (args, cwd) => {
      if (args[0] === "push" && !args.includes("--dry-run")) {
        pushArgv.push(Array.from(args));
        if (args.includes("--porcelain")) {
          const tempBranch = "refs/heads/" + fixture.branchName;
          await originalRun(["push", "origin", fixture.baseCommit + ":" + tempBranch], cwd);
        }
      }
      return originalRun(args, cwd);
    };
    await writeFile(path.join(fixture.worktree, "feature.txt"), "test\\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]);
    let savedReceipt: any = null;
    const publisher = new GitPublisher({ runner: fixture.runner, inspectVerifiedChangeSet: async () => changeSet, persistReceipt: async (r) => { savedReceipt = r; } });
    
    await assert.rejects(publisher.publish(request(fixture, changeSet)), { code: "PUBLISH_REMOTE_BRANCH_EXISTS" });
    
    assert.equal(savedReceipt?.state, "COMMITTED");
    const remoteRef = await originalRun(["ls-remote", "--heads", "origin", "refs/heads/" + fixture.branchName], fixture.worktree);
    assert.equal(remoteRef.stdout.trim().split(/\s+/)[0], fixture.baseCommit, "Remote should still be at base");
    const realPush = pushArgv.find(args => args.includes("--porcelain"));
    assert.ok(realPush);
    assert.ok(!realPush.includes("--force"), "Must not use plain --force");
    assert.ok(!realPush.some(a => a.startsWith("+")), "Must not use +refspec");
    assert.ok(realPush.some(a => a.startsWith("--force-with-lease")), "Must use lease");
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-023: real push failing then recovering correctly via lease", async () => {
  const fixture = await createFixture();
  try {
    const originalRun = fixture.runner.run.bind(fixture.runner);
    let failedOnce = false;
    let pushCount = 0;
    fixture.runner.run = async (args, cwd) => {
      if (args[0] === "push" && args.includes("--porcelain") && !args.includes("--dry-run")) {
        pushCount++;
        if (!failedOnce) {
          failedOnce = true;
          await originalRun(args, cwd);
          return { exitCode: 1, stdout: "", stderr: "Connection dropped", executable: "git", args, cwd, duration_ms: 10 };
        }
      }
      return originalRun(args, cwd);
    };
    await writeFile(path.join(fixture.worktree, "feature.txt"), "test\\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]);
    const publisher = new GitPublisher({ runner: fixture.runner, inspectVerifiedChangeSet: async () => changeSet, persistReceipt: async () => {} });
    
    const receipt = await publisher.publish(request(fixture, changeSet));
    assert.equal(receipt.state, "PUSHED");
    assert.equal(failedOnce, true);
    assert.equal(pushCount, 1, "Should not retry push internally, should recover by checking remote state");
    const commits = await originalRun(["rev-list", "--count", "HEAD"], fixture.worktree);
    assert.equal(commits.stdout.trim(), "2", "Exactly one commit should be created");
  } finally {
    await fixture.cleanup();
  }
});

test("P5A-025: READY_FOR_COMMIT retry properly repeats the preflight check", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(path.join(fixture.worktree, "feature.txt"), "test\\n", "utf8");
    const changeSet = await inspectFixtureChangeSet(fixture.runner, fixture.worktree, ["feature.txt"]);
    
    let savedReceipt: any = null;
    const publisher = new GitPublisher({ runner: fixture.runner, inspectVerifiedChangeSet: async () => changeSet, persistReceipt: async (r) => { savedReceipt = r; } });
    
    const originalRun = fixture.runner.run.bind(fixture.runner);
    
    fixture.runner.run = async (args, cwd) => {
      if (args[0] === "commit") {
        return { exitCode: 1, stdout: "", stderr: "Simulated commit failure", executable: "git", args, cwd, duration_ms: 10 };
      }
      return originalRun(args, cwd);
    };
    await assert.rejects(publisher.publish(request(fixture, changeSet)), { code: "PUBLISH_COMMIT_FAILED" });
    
    assert.ok(savedReceipt !== null);
    assert.equal(savedReceipt.state, "READY_FOR_COMMIT");
    const headAfterFail = await originalRun(["rev-parse", "HEAD"], fixture.worktree);
    assert.equal(headAfterFail.stdout.trim(), fixture.baseCommit);

    let pushCount = 0;
    fixture.runner.run = async (args, cwd) => {
      if (args[0] === "push" && !args.includes("--dry-run")) pushCount++;
      if (args.includes("--dry-run")) {
        return { exitCode: 1, stdout: "", stderr: "403 Forbidden", executable: "git", args, cwd, duration_ms: 10 };
      }
      return originalRun(args, cwd);
    };

    await assert.rejects(publisher.publish(request(fixture, changeSet), savedReceipt), { code: "PUBLISH_AUTH_FAILED" });
    assert.equal(savedReceipt.state, "READY_FOR_COMMIT", "Receipt remains READY_FOR_COMMIT");
    assert.equal(pushCount, 0, "Should not reach real push on retry");
    const headAfterRetry = await originalRun(["rev-parse", "HEAD"], fixture.worktree);
    assert.equal(headAfterRetry.stdout.trim(), fixture.baseCommit, "HEAD remains at base after retry fails");
    const status = await originalRun(["status", "--porcelain"], fixture.worktree);
    assert.match(status.stdout, /^A\s+feature\.txt/, "Staged paths unchanged (it was staged in the first run)");
  } finally {
    await fixture.cleanup();
  }
});
