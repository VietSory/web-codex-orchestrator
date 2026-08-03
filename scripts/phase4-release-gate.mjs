import { spawn } from "node:child_process";

const commands = [
  ["npm", ["ci"]],
  ["npm", ["run", "validate", "--", "./templates/task-bundle"]],
  ["npm", ["run", "typecheck"]],
  ["npm", ["test"]],
  ["npm", ["run", "build"]],
  ["npm", ["ls", "@openai/codex"]],
  ["npm", ["ls", "@openai/codex-sdk"]],
];

function run(executable, args, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: "inherit",
      shell: false,
      env: environment,
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${executable} ${args.join(" ")} failed with code ${String(code)} and signal ${String(signal)}.`));
        return;
      }
      resolve();
    });
  });
}

for (const [executable, args] of commands) {
  await run(executable, args);
}

await run("npm", ["run", "test:sandbox-integration"], {
  ...process.env,
  WCO_RUN_SANDBOX_INTEGRATION: "1",
});

if (process.env.WCO_SKIP_REAL_CODEX !== "1") {
  await run("npm", ["run", "test:codex-integration"], {
    ...process.env,
    WCO_RUN_CODEX_INTEGRATION: "1",
  });
}

console.log(JSON.stringify({
  status: "PASS",
  bundled_codex: "0.145.0",
  bundled_codex_sdk: "0.145.0",
  real_codex_integration: process.env.WCO_SKIP_REAL_CODEX === "1" ? "SKIPPED" : "PASS",
}));
