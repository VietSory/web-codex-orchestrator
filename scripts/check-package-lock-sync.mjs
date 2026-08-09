import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
}

function normalizedBin(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([name, target]) => [
    name,
    typeof target === "string" ? target.replace(/^\.\//, "") : target,
  ]));
}

function equal(left, right) {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

const rootPackage = packageLock?.packages?.[""];
const failures = [];

if (packageLock?.lockfileVersion !== 3) failures.push(`lockfileVersion must be 3, got ${String(packageLock?.lockfileVersion)}`);
if (!rootPackage || typeof rootPackage !== "object") failures.push("package-lock.json is missing packages[''] root metadata");

if (packageLock?.name !== packageJson.name) failures.push(`top-level name '${String(packageLock?.name)}' != package.json '${packageJson.name}'`);
if (packageLock?.version !== packageJson.version) failures.push(`top-level version '${String(packageLock?.version)}' != package.json '${packageJson.version}'`);

if (rootPackage) {
  if (rootPackage.name !== packageJson.name) failures.push(`root package name '${String(rootPackage.name)}' != package.json '${packageJson.name}'`);
  if (rootPackage.version !== packageJson.version) failures.push(`root package version '${String(rootPackage.version)}' != package.json '${packageJson.version}'`);
  if (!equal(rootPackage.dependencies ?? {}, packageJson.dependencies ?? {})) failures.push("root dependencies do not match package.json");
  if (!equal(rootPackage.devDependencies ?? {}, packageJson.devDependencies ?? {})) failures.push("root devDependencies do not match package.json");
  if (!equal(rootPackage.engines ?? {}, packageJson.engines ?? {})) failures.push("root engines do not match package.json");
  if (!equal(normalizedBin(rootPackage.bin ?? {}), normalizedBin(packageJson.bin ?? {}))) failures.push("root bin mapping does not match package.json");
}

if (failures.length > 0) {
  console.error("package-lock.json is not synchronized with package.json:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("package-lock.json root metadata is synchronized with package.json.");
