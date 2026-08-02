import { ExecutionError } from "../execution/errors.js";

const DENIED = [/^PATH$/i, /^HOME$/i, /^USERPROFILE$/i, /^SYSTEMROOT$/i, /^NODE_OPTIONS$/i, /^PYTHONPATH$/i, /^LD_PRELOAD$/i, /^DYLD_/i, /^GIT_CONFIG/i, /^SSH_/i, /^AWS_/i, /^AZURE_/i, /^GOOGLE_/i, /^GITHUB_/i, /^OPENAI_/i, /TOKEN/i, /SECRET/i, /PASSWORD/i, /CREDENTIAL/i, /AUTH/i, /PROXY/i];
export function validateEnvironment(environment: unknown, allowed: readonly string[]): Record<string, string> {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) throw new ExecutionError("VALIDATION_ENVIRONMENT_DENIED", "Validation environment must be an object.");
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!allowed.includes(key) || DENIED.some((pattern) => pattern.test(key)) || typeof value !== "string" || value.includes("\u0000") || value.length > 1024) throw new ExecutionError("VALIDATION_ENVIRONMENT_DENIED", `Validation environment key is denied: ${key}`);
    result[key] = value;
  }
  return result;
}
