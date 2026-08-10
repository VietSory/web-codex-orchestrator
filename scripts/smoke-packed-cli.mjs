import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const temp = mkdtempSync(path.join(os.tmpdir(), "wco-packed-smoke-"));
let tarball;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture ? `\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${String(result.status)}${details}`);
  }
  return result;
}

try {
  const packed = run(npm, ["pack", "--json"], { capture: true });
  const parsed = JSON.parse(packed.stdout);
  tarball = path.resolve(root, parsed[0].filename);

  run(npm, ["install", "--prefix", temp, "--omit=dev", "--ignore-scripts", tarball]);

  const bin = process.platform === "win32"
    ? path.join(temp, "node_modules", ".bin", "wco.cmd")
    : path.join(temp, "node_modules", ".bin", "wco");

  const version = run(bin, ["--version"], { cwd: temp, capture: true }).stdout.trim();
  if (version !== pkg.version) throw new Error(`Packed CLI version '${version}' != package version '${pkg.version}'.`);

  run(bin, ["--help"], { cwd: temp, capture: true });
  console.log(`Packed CLI clean-install smoke PASS (${pkg.name}@${pkg.version}).`);
} finally {
  if (tarball) {
    try { unlinkSync(tarball); } catch {}
  }
  rmSync(temp, { recursive: true, force: true });
}
