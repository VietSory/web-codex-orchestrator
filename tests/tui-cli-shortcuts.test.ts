import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/cli/index.ts", import.meta.url), "utf8");

test("shell continue shortcut enters the same interactive continuation command", () => {
  assert.match(source, /first === "--continue"/);
  assert.match(source, /runInteractiveApp\(startupInteractiveIo\("\/continue"\)\)/);
  assert.match(source, /Usage: wco --continue/);
});

test("shell resume shortcut enters the same saved-task picker or numbered resume command", () => {
  assert.match(source, /first === "--resume"/);
  assert.match(source, /`\/resume \$\{args\[1\]\}` : "\/resume"/);
  assert.match(source, /Usage: wco --resume \[history-number\]/);
  assert.match(source, /\^\\d\+\$\/u\.test\(args\[1\]\)/);
});

test("shell shortcuts do not create a second execution or authority path", () => {
  const helperStart = source.indexOf("function startupInteractiveIo");
  const helperEnd = source.indexOf("async function runInteractiveShortcut", helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /terminalIo\(\)/);
  assert.doesNotMatch(helper, /driveAutopilotJob|drivePairHarnessToCodeReview|runControlCommand|restoreLocalTaskHistoryFocus/);
});
