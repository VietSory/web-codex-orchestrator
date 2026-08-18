import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function text(path: string): Promise<string> {
  return await readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("release qualification requires deterministic relay efficiency and both provider value gates", async () => {
  const [packageText, localValidation] = await Promise.all([
    text("package.json"),
    text("docs/local-validation.md"),
  ]);
  const packageJson = JSON.parse(packageText) as { scripts?: Record<string, string> };
  const scripts = packageJson.scripts ?? {};

  assert.equal(scripts["benchmark:relay-efficiency"], "tsx scripts/benchmark-relay-efficiency.mts");
  assert.equal(scripts["benchmark:semantic:provider"], "tsx scripts/benchmark-semantic-provider.mts");
  assert.equal(scripts["benchmark:review:provider"], "tsx scripts/benchmark-review-provider.mts");
  assert.match(scripts.check ?? "", /benchmark:relay-efficiency/);

  assert.match(localValidation, /npm run benchmark:relay-efficiency/);
  assert.match(localValidation, /npm run benchmark:semantic:provider/);
  assert.match(localValidation, /npm run benchmark:review:provider/);
  assert.match(localValidation, /hidden-caller defect/i);
  assert.match(localValidation, /clean twin/i);
  assert.match(localValidation, /byte counts must never be presented as provider-token counts/i);
});

test("real dogfood fails if the user must manually relay ChatGPT and Codex payloads", async () => {
  const localValidation = await text("docs/local-validation.md");

  assert.match(localValidation, /manual ChatGPT↔Codex payload copy\/paste = 0/);
  assert.match(localValidation, /If such a handoff is required to finish the task, the dogfood run fails/i);
  assert.match(localValidation, /manual ChatGPT↔Codex payload copy\/paste count is exactly `0`/);
  assert.match(localValidation, /Any material bug discovered during this acceptance returns the candidate to code\/review qualification/i);
});
