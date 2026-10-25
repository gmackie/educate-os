/**
 * The kinds of secret-shaped text a `.educateos` archive must never carry. Each pattern is specific
 * enough that ordinary prose ("the secret of good writing") does not match: generic assignments
 * need a value containing a digit, and URL parameters need a long value.
 */
const SECRET_PATTERNS: readonly { kind: string; pattern: RegExp }[] = [
  { kind: "private-key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { kind: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: "api-secret-key", pattern: /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|[rs]k_(?:live|test)_[A-Za-z0-9]{16,})/ },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { kind: "url-credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  {
    kind: "url-token-parameter",
    pattern: /[?&](?:access_token|refresh_token|id_token|token|api_?key|key|sig|signature|password|code)=[^&\s"'#]{12,}/i,
  },
  {
    kind: "credential-assignment",
    pattern: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth[_-]?token)["']?\s*[:=]\s*["']?(?=[^\s"']*\d)[A-Za-z0-9_\-./+=]{12,}/i,
  },
];

/** The kinds of secret-shaped text found in `text`, empty when there are none. */
export function findSecretShapes(text: string): string[] {
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ kind }) => kind);
}
