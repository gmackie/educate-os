// Reaching Hall Monitor: the client and its transport, the service token it authenticates with,
// and the mapping from its cost receipt to ledger attempts.

import {
  createHallMonitorClient,
  fetchTransport,
  serviceBindingTransport,
  type HallMonitorClient,
  type TokenSource,
} from "@gmacko/hall-monitor-client";
import type { CostReceipt, UsageAttempt } from "@gmacko/hall-monitor-contracts";
import { normalizeTokenUsage, type AiAttempt, type TokenUsage } from "@educateos/ai-governance";
import type { GuardConfig } from "./config.ts";

/**
 * Lifetime of a minted service token, in seconds: one call and its retries' clock skew (Hall Monitor
 * allows 60 s of skew). The client's own default.
 */
const TOKEN_LIFETIME_SECONDS = 60;

/** The service-token signing key: a private JWK, Ed25519 (`EdDSA`) or P-256 (`ES256`). */
interface SigningJwk extends JsonWebKey {
  kid?: string;
}

const encoder = new TextEncoder();
const base64Url = (bytes: Uint8Array) => bytes.toBase64({ alphabet: "base64url", omitPadding: true });
const encodeJson = (value: unknown) => base64Url(encoder.encode(JSON.stringify(value)));

// Token sources by everything that shapes a token, so an isolate parses and imports the key once
// rather than on every call.
const tokenSources = new Map<string, TokenSource>();

/**
 * Mints Hall Monitor service tokens: compact JWS, signed with `HALL_MONITOR_SIGNING_KEY`, carrying
 * the claims Hall Monitor verifies (`iss`, `aud`, `exp`, `iat`, `jti`, `tenant`, `scope`). Every call
 * mints a new token with its own `jti`: Hall Monitor accepts each token once and answers a replay
 * with 401, and transports ask for a token on every attempt, retries included. Returns `undefined`
 * when no signing key is configured.
 */
export function serviceTokenSource(env: Cloudflare.Env, config: GuardConfig): TokenSource | undefined {
  if (!env.HALL_MONITOR_SIGNING_KEY) return undefined;
  const issuer = env.HALL_MONITOR_ISSUER;
  if (!issuer) throw new Error("HALL_MONITOR_ISSUER must be set with HALL_MONITOR_SIGNING_KEY");
  const audience = env.HALL_MONITOR_AUDIENCE || "hall-monitor";
  const cacheKey = JSON.stringify([env.HALL_MONITOR_SIGNING_KEY, issuer, audience, config.moderation.tenantId]);
  const known = tokenSources.get(cacheKey);
  if (known !== undefined) return known;
  let jwk: SigningJwk;
  try {
    jwk = JSON.parse(env.HALL_MONITOR_SIGNING_KEY) as SigningJwk;
  } catch {
    throw new Error("HALL_MONITOR_SIGNING_KEY is not a JSON Web Key");
  }
  const alg = jwk.kty === "OKP" && jwk.crv === "Ed25519" ? "EdDSA" : jwk.kty === "EC" && jwk.crv === "P-256" ? "ES256" : undefined;
  if (alg === undefined || jwk.d === undefined) throw new Error("HALL_MONITOR_SIGNING_KEY must be a private Ed25519 or P-256 JWK");
  const { kid, ...material } = jwk;
  const key = crypto.subtle.importKey("jwk", material, alg === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const params = alg === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
  const source: TokenSource = async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg, typ: "JWT", ...(kid === undefined ? {} : { kid }) };
    const claims = {
      iss: issuer,
      aud: audience,
      iat: now,
      exp: now + TOKEN_LIFETIME_SECONDS,
      jti: crypto.randomUUID(),
      tenant: config.moderation.tenantId,
      scope: "evaluate",
    };
    const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
    const signature = new Uint8Array(await crypto.subtle.sign(params, await key, encoder.encode(signingInput)));
    return `${signingInput}.${base64Url(signature)}`;
  };
  tokenSources.set(cacheKey, source);
  return source;
}

/**
 * The Hall Monitor client, or `null` when none is configured. A `HALL_MONITOR` service binding
 * (a district running Hall Monitor in its own account) is preferred; otherwise `HALL_MONITOR_URL`
 * is called over HTTPS, which needs a signing key, since the public endpoint authenticates every
 * call. A service-binding call carries a token too when a key is configured.
 */
export function hallMonitorClient(env: Cloudflare.Env, config: GuardConfig): HallMonitorClient | null {
  const getToken = serviceTokenSource(env, config);
  const timeoutMs = config.moderation.timeoutMs;
  if (env.HALL_MONITOR !== undefined) {
    return createHallMonitorClient({ transport: serviceBindingTransport(env.HALL_MONITOR, getToken === undefined ? {} : { getToken }), timeoutMs });
  }
  if (env.HALL_MONITOR_URL && getToken !== undefined) {
    return createHallMonitorClient({ transport: fetchTransport({ baseUrl: env.HALL_MONITOR_URL, getToken }), timeoutMs });
  }
  return null;
}

function attemptUsage(attempt: UsageAttempt): TokenUsage | undefined {
  const { inputTokens, cachedInputTokens, outputTokens } = attempt.units;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  try {
    // Hall Monitor's input count includes the cached tokens; the ledger's excludes them.
    return normalizeTokenUsage({
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      cacheReadTokens: cachedInputTokens ?? 0,
      inputIncludesCache: true,
    });
  } catch {
    return undefined;
  }
}

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * A Hall Monitor receipt's attempts as ledger attempts, amounts unchanged (both are `UsdNano`
 * strings). An attempt Hall Monitor could not price, or reports as `unknown`, stays `unknown`, so
 * the ledger charges it at the hold rather than $0. A priced attempt whose token counts are
 * missing (a Workers AI attempt billed in neurons, say) is recorded with zero tokens: its cost is
 * what the ledger charges. Attempts are ordered by index and renumbered if Hall Monitor repeated one.
 */
export function receiptAttempts(receipt: CostReceipt): AiAttempt[] {
  const sorted = receipt.attempts.toSorted((a, b) => a.attemptIndex - b.attemptIndex);
  const strictlyIncreasing = sorted.every((attempt, i) => i === 0 || attempt.attemptIndex > sorted[i - 1]!.attemptIndex);
  return sorted.map((attempt, i): AiAttempt => {
    const ids = {
      attemptIndex: strictlyIncreasing ? attempt.attemptIndex : i,
      ...(attempt.providerRequestId === undefined ? {} : { providerRequestId: attempt.providerRequestId }),
      ...(attempt.gatewayLogId === undefined ? {} : { gatewayLogId: attempt.gatewayLogId }),
    };
    const usage = attemptUsage(attempt);
    if (attempt.state === "unknown" || attempt.grossUsdNano === undefined) {
      return { ...ids, state: "unknown", ...(usage === undefined ? {} : { usage }) };
    }
    return { ...ids, state: attempt.state, usage: usage ?? ZERO_USAGE, actualUsdNano: attempt.grossUsdNano };
  });
}
