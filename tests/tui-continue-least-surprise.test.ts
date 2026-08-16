import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/tui/interactive-app.ts", import.meta.url), "utf8");

test("continue never changes task focus by selecting historical work implicitly", () => {
  const start = source.indexOf("const continueBestTask = async");
  const end = source.indexOf("const resumeFromHistory", start);
  assert.ok(start >= 0 && end > start, "continue helper must remain directly auditable");
  const block = source.slice(start, end);

  assert.doesNotMatch(block, /recentTaskHistory\(|resumeHistoryItem\(/,
    "`/continue` must only act on the current task; switching to history requires explicit `/resume`");
  assert.match(block, /\/resume/,
    "when there is no current task to continue, the user should be directed to explicit `/resume`");
  assert.doesNotMatch(source, /const currentTaskIsPaused/,
    "`/resume` must not retain a hidden paused-current continuation path");
});
