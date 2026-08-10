import { readFileSync } from "node:fs";
import { WebBridgeError, WEB_BRIDGE_PROTOCOL_VERSION } from "./contracts.js";

export interface ManagedWebServiceMetadata {
  schema_version: "1.0";
  deployment_status: "available" | "required" | "test";
  protocol_version: typeof WEB_BRIDGE_PROTOCOL_VERSION;
  relay_url: string | null;
  gpt_url: string | null;
}

const metadataUrl = new URL("../../web/managed-service.json", import.meta.url);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebBridgeError("WEB_MANAGED_METADATA_INVALID", "Managed Web service metadata must be an object.");
  return value as Record<string, unknown>;
}

function cleanUrl(value: unknown, label: string, options: { allowLoopback: boolean; originOnly: boolean }): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 || value.length > 4096) throw new WebBridgeError("WEB_MANAGED_METADATA_INVALID", `${label} must be a clean URL.`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new WebBridgeError("WEB_MANAGED_METADATA_INVALID", `${label} must be a valid URL.`); }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.hash || parsed.search || options.originOnly && parsed.pathname !== "/" || parsed.protocol !== "https:" && !(options.allowLoopback && loopback && parsed.protocol === "http:")) {
    throw new WebBridgeError("WEB_MANAGED_METADATA_INVALID", `${label} must be a clean HTTPS URL without credentials, query, or fragment.`);
  }
  return options.originOnly ? parsed.origin : parsed.href;
}

export function validateManagedWebServiceMetadata(value: unknown, options: { allowLoopback?: boolean } = {}): ManagedWebServiceMetadata {
  const raw = record(value);
  const allowed = new Set(["schema_version", "deployment_status", "protocol_version", "relay_url", "gpt_url"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new WebBridgeError("WEB_MANAGED_METADATA_INVALID", `Managed Web service metadata contains unknown field '${key}'.`);
  if (raw.schema_version !== "1.0" || raw.protocol_version !== WEB_BRIDGE_PROTOCOL_VERSION || !["available", "required", "test"].includes(String(raw.deployment_status))) {
    throw new WebBridgeError("WEB_MANAGED_METADATA_INVALID", "Managed Web service metadata version/status is invalid.");
  }
  if (raw.deployment_status === "required") {
    if (raw.relay_url !== null || raw.gpt_url !== null) throw new WebBridgeError("WEB_MANAGED_METADATA_INVALID", "Deployment-required metadata must not advertise unverified service URLs.");
    return { schema_version: "1.0", deployment_status: "required", protocol_version: WEB_BRIDGE_PROTOCOL_VERSION, relay_url: null, gpt_url: null };
  }
  return {
    schema_version: "1.0",
    deployment_status: raw.deployment_status as "available" | "test",
    protocol_version: WEB_BRIDGE_PROTOCOL_VERSION,
    relay_url: cleanUrl(raw.relay_url, "relay_url", { allowLoopback: options.allowLoopback === true, originOnly: true }),
    gpt_url: cleanUrl(raw.gpt_url, "gpt_url", { allowLoopback: false, originOnly: false }),
  };
}

export const MANAGED_WEB_SERVICE = validateManagedWebServiceMetadata(JSON.parse(readFileSync(metadataUrl, "utf8")));

export function resolveManagedWebService(env: NodeJS.ProcessEnv = process.env): ManagedWebServiceMetadata {
  if (env.WCO_MANAGED_WEB_TEST_OVERRIDE === "1") {
    return validateManagedWebServiceMetadata({
      schema_version: "1.0",
      deployment_status: "test",
      protocol_version: WEB_BRIDGE_PROTOCOL_VERSION,
      relay_url: env.WCO_MANAGED_WEB_RELAY_URL ?? null,
      gpt_url: env.WCO_MANAGED_WEB_GPT_URL ?? null,
    }, { allowLoopback: true });
  }
  if (MANAGED_WEB_SERVICE.deployment_status !== "available") {
    throw new WebBridgeError("WEB_MANAGED_DEPLOYMENT_REQUIRED", "The managed WCO Relay and Senior Architect GPT have not been deployed by the service owner.");
  }
  return MANAGED_WEB_SERVICE;
}

export function managedServiceRoute(metadata: ManagedWebServiceMetadata, route: string): URL {
  if (!metadata.relay_url) throw new WebBridgeError("WEB_MANAGED_DEPLOYMENT_REQUIRED", "The managed WCO Relay is not deployed.");
  if (!route.startsWith("/v1/managed/") || route.includes("\\") || route.includes("..")) throw new WebBridgeError("WEB_MANAGED_ROUTE_INVALID", "Managed service route is invalid.");
  const result = new URL(route, metadata.relay_url);
  if (result.origin !== new URL(metadata.relay_url).origin) throw new WebBridgeError("WEB_MANAGED_ROUTE_INVALID", "Managed service route escaped its configured origin.");
  return result;
}
