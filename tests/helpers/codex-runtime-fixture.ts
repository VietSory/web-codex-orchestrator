import type { ResolvedCodexRuntime } from "../../src/runtime/codex-runtime.js";

export function fakeResolvedCodexRuntime(
  overrides: Partial<ResolvedCodexRuntime> = {},
): ResolvedCodexRuntime {
  return {
    executable: process.execPath,
    prefix_args: ["/trusted/@openai/codex/bin/codex.js"],
    environment: {
      PATH: "/trusted/bin",
    },
    source: "bundled",
    package_version: "0.145.0",
    launcher_path: "/trusted/@openai/codex/bin/codex.js",
    ...overrides,
  };
}
