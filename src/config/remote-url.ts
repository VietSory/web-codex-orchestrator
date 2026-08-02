/** Returns true for HTTP(S) URLs that embed userinfo or credentials. */
export function hasSensitiveHttpUserInfo(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.username.length > 0 || parsed.password.length > 0
      : false;
  } catch {
    // A malformed URL will be rejected by the normal registry validation. Do
    // not echo the value, since it may contain a credential-like token.
    return true;
  }
}
/** Removes HTTP(S) userinfo before a remote URL is persisted or displayed. */
export function sanitizeRemoteUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "[redacted-invalid-remote-url]";
  }
}
