import crypto from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonBuffer } from "../result-bundle/canonical-json.js";
import { atomicWriteText } from "../run/run-store.js";
import { WebBridgeError } from "./contracts.js";

export interface PersonalActionAssets {
  directory: string;
  openapi_path: string;
  instructions_path: string;
  conversation_starters_path: string;
  manifest_path: string;
}

function sha256(value: Buffer | string): string { return crypto.createHash("sha256").update(value).digest("hex"); }

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function cleanRelayUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new WebBridgeError("WEB_PERSONAL_RELAY_URL_UNSAFE", "Personal relay URL must be a clean HTTPS origin.");
  return parsed.origin;
}

async function safeOutput(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) throw new WebBridgeError("WEB_PERSONAL_ASSET_PATH_UNSAFE", "Personal Action asset directory is unsafe.");
  await chmod(absolute, 0o700).catch(() => undefined);
  return absolute;
}

export function generatePersonalRelaySecret(): string {
  return `wco_${crypto.randomBytes(32).toString("base64url")}`;
}

export async function materializePersonalActionAssets(directory: string, relayUrl: string): Promise<PersonalActionAssets> {
  const output = await safeOutput(directory);
  const sourceRoot = path.join(packageRoot(), "web", "gpt");
  const managedSchema = await readFile(path.join(sourceRoot, "openapi.yaml"), "utf8");
  const component = managedSchema.indexOf("components:\n");
  if (component < 1) throw new WebBridgeError("WEB_PERSONAL_SCHEMA_TEMPLATE_INVALID", "Managed Action schema template is missing components.");
  const openapi = `${managedSchema.slice(0, component)
    .replace("https://deployment-required.invalid", cleanRelayUrl(relayUrl))
    .replace("security:\n  - wcoOAuth: [wco.action]", "security:\n  - wcoApiKey: []")}
components:
  securitySchemes:
    wcoApiKey:
      type: apiKey
      in: header
      name: Authorization
      description: In the GPT editor choose API Key, Bearer authentication. The secret is never part of this schema.
`;
  if (/oauth|deployment-required\.invalid/i.test(openapi)) throw new WebBridgeError("WEB_PERSONAL_SCHEMA_TEMPLATE_INVALID", "Personal Action schema retained managed-only metadata.");
  const files = {
    "openapi.yaml": Buffer.from(openapi, "utf8"),
    "WCO-SENIOR-ARCHITECT.md": await readFile(path.join(sourceRoot, "WCO-SENIOR-ARCHITECT.md")),
    "conversation-starters.md": await readFile(path.join(sourceRoot, "conversation-starters.md")),
  };
  for (const [name, content] of Object.entries(files)) await atomicWriteText(path.join(output, name), content.toString("utf8"));
  const manifest = canonicalJsonBuffer({ schema_version: "1.0", profile: "personal_actions", relay_url: cleanRelayUrl(relayUrl), files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { sha256: sha256(content), size_bytes: content.byteLength }])) });
  await atomicWriteText(path.join(output, "manifest.json"), manifest.toString("utf8"));
  return { directory: output, openapi_path: path.join(output, "openapi.yaml"), instructions_path: path.join(output, "WCO-SENIOR-ARCHITECT.md"), conversation_starters_path: path.join(output, "conversation-starters.md"), manifest_path: path.join(output, "manifest.json") };
}
