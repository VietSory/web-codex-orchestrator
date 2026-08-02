const SECRET_PATTERNS = [
  /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
  /([?&](?:token|access_token|api[_-]?key|secret|password|authorization)=)[^&\s]+/gi,
  /token\s*[:=]\s*[^\s,;]+/gi,
  /password\s*[:=]\s*[^\s,;]+/gi,
  /secret\s*[:=]\s*[^\s,;]+/gi,
  /authorization\s*[:=]\s*[^\s,;]+/gi,
  /api[_-]?key\s*[:=]\s*[^\s,;]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|sk-proj|ghp|github_pat|xoxb)[_-][A-Za-z0-9_-]+\b/g,
];
export function redact(value: string): string {
  return SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, (match) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(match)) return match.replace(/:\/\/[^\s/@]+(?::[^\s/@]*)?@/i, "://[REDACTED]@");
    if (/^[?&]/.test(match)) return match.replace(/=[^=]*$/, "=[REDACTED]");
    if (/^\s*Bearer\s/i.test(match)) return "Bearer [REDACTED]";
    if (/^[A-Za-z]/.test(match) && !/^[^:=]+[_-]/.test(match)) return match.replace(/[:=].*$/, ": [REDACTED]");
    return "[REDACTED]";
  }), value);
}
