import assert from "node:assert/strict";
import test from "node:test";
import { publishedResumeDigestIsAllowed } from "../src/executor/resume-source.js";

const source = "1".repeat(64);
const current = "2".repeat(64);
const unrelated = "3".repeat(64);

test("post-publish resume accepts only the exact current or repair-source change-set generation", () => {
  assert.equal(publishedResumeDigestIsAllowed(current, undefined, current), true, "normal publication must bind current digest");
  assert.equal(publishedResumeDigestIsAllowed(current, undefined, source), false, "without repair there is no alternate generation");

  assert.equal(publishedResumeDigestIsAllowed(current, source, source), true, "repair-before-republish may still have source generation published");
  assert.equal(publishedResumeDigestIsAllowed(current, source, current), true, "after republish the final/current generation is valid while source remains audit history");
  assert.equal(publishedResumeDigestIsAllowed(current, source, unrelated), false, "no third generation can authorize resume");
});
