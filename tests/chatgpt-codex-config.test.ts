import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { validateConfig } from "../src/config/config-validator.js";

function baseConfig() {
  return {
    config_version: "1.0",
    inbox: {
      poll_interval_ms: 2_000,
      stable_age_ms: 3_000,
      stable_observations: 2,
      maximum_candidates_per_scan: 100,
    },
    repositories: {
      repo: {
        path: path.resolve("repo"),
        remote: "origin",
        expected_remote_urls: ["https://github.com/example/repo.git"],
        fetch_policy: "never",
      },
    },
  };
}

test("explicit chatgpt_codex profile is accepted by the same runtime validator as its TypeScript contract", () => {
  const report = validateConfig({
    ...baseConfig(),
    web_bridge: {
      mode: "chatgpt_codex",
      poll_interval_ms: 1_000,
      job_ttl_seconds: 86_400,
    },
  });

  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.equal(report.config?.web_bridge?.mode, "chatgpt_codex");
});

test("chatgpt_codex cannot smuggle relay or GPT endpoints into trusted config", () => {
  for (const forbidden of [
    { relay_url: "https://relay.example.com" },
    { gpt_url: "https://chatgpt.com/g/example" },
  ]) {
    const report = validateConfig({
      ...baseConfig(),
      web_bridge: {
        mode: "chatgpt_codex",
        poll_interval_ms: 1_000,
        job_ttl_seconds: 86_400,
        ...forbidden,
      },
    });

    assert.equal(report.ok, false);
    assert.match(report.issues.map((issue) => issue.message).join("\n"), /chatgpt_codex.*relay_url and gpt_url are forbidden/i);
  }
});
