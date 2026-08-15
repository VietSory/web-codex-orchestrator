import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/tui/interactive-app.ts", import.meta.url), "utf8");

test("continue never silently leaves a blocked current task for older history", () => {
  const start = source.indexOf("const continueBestTask = async");
  const end = source.indexOf("const currentTaskIsPaused", start);
  const block = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /latest\?\.state === "BLOCKED"/);
  assert.match(block, /current task needs your attention/i);
  assert.match(block, /Use \/resume only if you intentionally want to switch/i);
  assert.doesNotMatch(block, /recentTaskHistory\(\)|resumeHistoryItem\(/,
    "`/continue` must never change focus by selecting historical work implicitly");
});

test("blocked tasks are unfinished for replacement and resume-switch confirmation", () => {
  const replaceStart = source.indexOf("const confirmTaskReplacement = async");
  const replaceEnd = source.indexOf("const recentTaskHistory", replaceStart);
  const replace = source.slice(replaceStart, replaceEnd);
  assert.match(replace, /!latest \|\| latest\.state === "COMPLETED"/);
  assert.doesNotMatch(replace, /latest\.state === "BLOCKED"\) return true/);

  const resumeStart = source.indexOf("const resumeHistoryItem = async");
  const resumeEnd = source.indexOf("const continueBestTask", resumeStart);
  const resume = source.slice(resumeStart, resumeEnd);
  assert.match(resume, /latest && latest\.state !== "COMPLETED"/);
  assert.doesNotMatch(resume, /latest\.state !== "BLOCKED"/);
});

test("PAIR status uses presenter continuation semantics without string-rewrite hacks", () => {
  assert.doesNotMatch(source, /\.replace\(\/\\\/run\/g/);
  assert.match(source, /return \{ message: formatPairStatus\(/);
});

test("background state exposes only commands that the single-owner runtime can accept", () => {
  assert.match(source, /availableCommands: background \? \[\.\.\.LIVE_BACKGROUND_COMMANDS\] : undefined/);
  assert.match(source, /commandPalette\(background \? LIVE_BACKGROUND_COMMANDS : undefined\)/);
  assert.match(source, /background && !LIVE_BACKGROUND_COMMANDS\.has\(command\)/);
  assert.doesNotMatch(source.match(/LIVE_BACKGROUND_COMMANDS = new Set\([^\n]+/)?.[0] ?? "", /\/continue|\/resume|\/new|\/auto/);
});
