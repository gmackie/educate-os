// Credential material is bound through Worker secrets, never configuration (ADR-0004, roadmap
// §4.1). This scan runs on the raw document before anything else reads it, so a pasted credential
// is refused by name and location and never reaches a revision, a diff or an error message.

/** Where a credential-looking key or value was found. The value itself is never reported. */
export interface SecretFinding {
  /** `key` for a credential-like field name, `value` for a credential-like string. */
  kind: "key" | "value";
  /** JSON Pointer to the offending field. */
  path: string;
}

const SECRET_WORDS = new Set(["secret", "secrets", "password", "passwd", "passphrase", "credential", "credentials"]);
const KEY_QUALIFIERS = new Set(["api", "private", "access", "secret", "signing", "auth", "encryption", "client"]);

/** Splits `clientSecret`, `client_secret` or `client-secret` into lower-case words. */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/**
 * Whether a field name names a credential. `token` and `key` count only as the last word, with
 * `key` also needing a qualifier (`apiKey`, `privateKey`), so settings such as `maxTokensPerRun` or
 * `keyStage` are not mistaken for secrets.
 */
export function isCredentialKey(key: string): boolean {
  const parts = words(key);
  if (parts.some((word) => SECRET_WORDS.has(word) || word === "apikey" || word === "privatekey")) return true;
  const last = parts.at(-1);
  if (last === "token" || last === "jwt" || last === "bearer") return true;
  return last === "key" && parts.length > 1 && KEY_QUALIFIERS.has(parts.at(-2)!);
}

const TOKEN_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/, // JWT
  /^(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /^(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /^github_pat_\w{20,}/,
  /^glpat-[\w-]{20,}/,
  /^xox[abposr]-[\w-]{10,}/,
  /^AKIA[0-9A-Z]{16}$/,
  /^Bearer\s+\S{8,}/i,
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, // a URL with a password in it
];

/**
 * Whether a string looks like a credential: a known token format, or a long unbroken run of mixed
 * upper case, lower case and digits typical of an encoded key. Lower-case hex digests and EducateOS
 * IDs do not match the generic rule.
 */
export function isCredentialValue(value: string): boolean {
  if (TOKEN_SHAPES.some((shape) => shape.test(value))) return true;
  return value.length >= 32 && /^[A-Za-z0-9+/_=-]+$/.test(value)
    && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value);
}

/** Escapes a key for a JSON Pointer (RFC 6901). */
export function pointerSegment(key: string | number): string {
  return String(key).replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Every credential-looking key or string value anywhere in `value`, in document order. */
export function findSecrets(value: unknown, path = ""): SecretFinding[] {
  if (typeof value === "string") return isCredentialValue(value) ? [{ kind: "value", path }] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => findSecrets(item, `${path}/${index}`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = `${path}/${pointerSegment(key)}`;
    // A credential-named field is refused whatever it holds, even an empty placeholder.
    return isCredentialKey(key) ? [{ kind: "key" as const, path: childPath }] : findSecrets(child, childPath);
  });
}
