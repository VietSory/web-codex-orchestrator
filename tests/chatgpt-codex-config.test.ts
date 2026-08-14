import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { validateTrustedConfig } from "../src/config/config-loader.js";
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

test("explicit chatgpt_codex identity validates structurally and canonicalizes to the zero-config local form", () => {
  const input = {
    ...baseConfig(),
    web_bridge: {
      mode: "chatgpt_codex",
      poll_interval_ms: 1_000,
      job_ttl_seconds: 86_400,
    },
  };
  const structural = validateConfig(input);
  assert.equal(structural.ok, true, JSON.stringify(structural.issues));
  assert.equal(structural.config?.web_bridge?.mode, "chatgpt_codex");

  const trusted = validateTrustedConfig(input);
  assert.equal(trusted.ok, true, JSON.stringify(trusted.issues));
  assert.equal(trusted.config?.web_bridge, undefined, "all product routing must see the canonical local zero-config form");
});

test("chatgpt_codex cannot smuggle relay or GPT endpoints into trusted config", () => {
  for (const forbidden of [
    { relay_url: "https://relay.example.com" },
    { gpt_url: "https://chatgpt.com/g/example" },
  ]) {
    const input = {
      ...baseConfig(),
      web_bridge: {
        mode: "chatgpt_codex",
        poll_interval_ms: 1_000,
        job_ttl_seconds: 86_400,
        ...forbidden,
      },
    };
    const structural = validateConfig(input);
    assert.equal(structural.ok, false);
    assert.match(structural.issues.map((issue) => issue.message).join("\n"), /chatgpt_codex.*relay_url and gpt_url are forbidden/i);

    const trusted = validateTrustedConfig(input);
    assert.equal(trusted.ok, false);
  }
});
