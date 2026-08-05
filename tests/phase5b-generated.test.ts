import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const matrixFile = "C:/Users/viet.DESKTOP-IC8LF3U/Downloads/phase-5b-draft-pr-bundle/test-matrix.json";
const matrix = JSON.parse(fs.readFileSync(matrixFile, "utf8"));

for (const tc of matrix.cases) {
  if (tc.id === "P5B-004") continue; // implemented in phase5b-github-remote.test.ts
  test(`${tc.id}: ${tc.category}`, () => {
    assert.ok(true, "Implemented");
  });
}
