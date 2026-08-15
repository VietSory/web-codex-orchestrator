const URL_CREDENTIAL_PATTERN = /(^|[^A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi;

const SECRET_PATTERNS = [
  /([?&](?:token|access_token|api[_-]?key|secret|password|authorization)=)[^&\s]+/gi,
  /token\s*[:=]\s*[^\s,;]+/gi,
  /password\s*[:=]\s*[^\s,;]+/gi,
  /secret\s*[:=]\s*[^\s,;]+/gi,
  /authorization\s*[:=]\s*[^\s,;]+/gi,
  /api[_-]?key\s*[:=]\s*[^\s,;]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|sk-proj|ghp|github_pat|xoxb)[_-][A-Za-z0-9_-]+\b/g,
];

function redactUrlCredentials(value: string): string {
  // Requiring a non-scheme boundary prevents the engine from retrying an
  // unbounded greedy scheme match at every character of long plaintext.
  // The boundary is preserved verbatim so surrounding log text is unchanged.
  return value.replace(URL_CREDENTIAL_PATTERN, (_match, boundary: string, scheme: string) => `${boundary}${scheme}[REDACTED]@`);
}

export function redact(value: string): string {
  return SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, (match) => {
    if (/^[?&]/.test(match)) return match.replace(/=[^=]*$/, "=[REDACTED]");
    if (/^\s*Bearer\s/i.test(match)) return "Bearer [REDACTED]";
    if (/^[A-Za-z]/.test(match) && !/^[^:=]+[_-]/.test(match)) return match.replace(/[:=].*$/, ": [REDACTED]");
    return "[REDACTED]";
  }), redactUrlCredentials(value));
}
