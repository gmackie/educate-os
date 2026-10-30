// Reaching Hall Monitor: the client and its transport, the service token it authenticates with,
// and the mapping from its cost receipt to ledger attempts.

import {
  createHallMonitorClient,
  fetchTransport,
  serviceBindingTransport,
  type HallMonitorClient,
  type CallOptions,
  type TokenSource,
  type Transport,
} from "@gmacko/hall-monitor-client";
import type { CostReceipt, EvaluationRequest, EvaluationResult, UsageAttempt } from "@gmacko/hall-monitor-contracts";
import { normalizeTokenUsage, type AiAttempt, type TokenUsage } from "@educateos/ai-governance";
import type { GuardConfig } from "./config.ts";
import type { GuardContext } from "./context.ts";
import { SourceGovernanceError, sourceGovernanceContext, type SourceGovernanceContext } from "./source-governance.ts";

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

// Cache only key signers. Request claims stay in the per-evaluation closure, so parallel checks
// cannot share eligibility and the cache does not retain principal/request context.
type TokenSigner = (governance?: (now: number, expiresAt: number) => SourceGovernanceContext) => Promise<string>;
const tokenSigners = new Map<string, TokenSigner>();

/**
 * Mints Hall Monitor service tokens: compact JWS, signed with `HALL_MONITOR_SIGNING_KEY`, carrying
 * the claims Hall Monitor verifies (`iss`, `aud`, `exp`, `iat`, `jti`, `tenant`, `scope`). Every call
 * mints a new token with its own `jti`: Hall Monitor accepts each token once and answers a replay
 * with 401, and transports ask for a token on every attempt, retries included. Returns `undefined`
 * when no signing key is configured.
 */
export function serviceTokenSource(env: Cloudflare.Env, config: GuardConfig, governance?: (now: number, expiresAt: number) => SourceGovernanceContext): TokenSource | undefined {
  if (!env.HALL_MONITOR_SIGNING_KEY) return undefined;
  const issuer = env.HALL_MONITOR_ISSUER;
  if (!issuer) throw new Error("HALL_MONITOR_ISSUER must be set with HALL_MONITOR_SIGNING_KEY");
  const audience = env.HALL_MONITOR_AUDIENCE || "hall-monitor";
  const tenantId = config.moderation.tenantId;
  const cacheKey = JSON.stringify([env.HALL_MONITOR_SIGNING_KEY, issuer, audience, tenantId]);
  const known = tokenSigners.get(cacheKey);
  if (known !== undefined) return () => known(governance);
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
  const sign: TokenSigner = async (context) => {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + TOKEN_LIFETIME_SECONDS;
    const header = { alg, typ: "JWT", ...(kid === undefined ? {} : { kid }) };
    const claims = {
      iss: issuer,
      aud: audience,
      iat: now,
      exp: expiresAt,
      jti: crypto.randomUUID(),
      tenant: tenantId,
      scope: "evaluate",
      ...(context === undefined ? {} : { hm_governance: context(now, expiresAt) }),
    };
    const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
    const signature = new Uint8Array(await crypto.subtle.sign(params, await key, encoder.encode(signingInput)));
    return `${signingInput}.${base64Url(signature)}`;
  };
  tokenSigners.set(cacheKey, sign);
  return () => sign(governance);
}

/** The existing client with trusted source context available only to its evaluation adapter. */
export interface GuardHallMonitorClient extends HallMonitorClient {
  /** Source context is resolved by the guard; it is never accepted on the public RPC seam. */
  evaluate(request: EvaluationRequest, options?: CallOptions & { sourceContext?: GuardContext }): Promise<EvaluationResult>;
}

/**
 * The Hall Monitor client, or `null` when none is configured. A `HALL_MONITOR` service binding
 * (a district running Hall Monitor in its own account) is preferred; otherwise `HALL_MONITOR_URL`
 * is called over HTTPS, which needs a signing key, since the public endpoint authenticates every
 * call. A service-binding call carries a token too when a key is configured.
 */
export function hallMonitorClient(env: Cloudflare.Env, config: GuardConfig): GuardHallMonitorClient | null {
  const getToken = serviceTokenSource(env, config);
  if (config.moderation.governance !== undefined && getToken === undefined) return null;
  const timeoutMs = config.moderation.timeoutMs;
  const client = (token: TokenSource | undefined, governed = false) => clientWithToken(env, timeoutMs, token, governed);
  const legacy = client(getToken);
  if (legacy === null || config.moderation.governance === undefined) return legacy;
  return {
    ...legacy,
    async evaluate(request, options) {
      const { sourceContext: context, ...callOptions } = options ?? {};
      if (context === undefined) throw new SourceGovernanceError();
      // Validate before creating a request, then recheck time/eligibility for every transport retry.
      const governance = (now: number, expiresAt: number) => sourceGovernanceContext(config, context, request, now, expiresAt);
      const now = Math.floor(Date.now() / 1000);
      governance(now, now + TOKEN_LIFETIME_SECONDS);
      return client(serviceTokenSource(env, config, governance), true)!.evaluate(request, callOptions);
    },
    async evaluateBatch() {
      // One request-bound JWT cannot authorize a batch of independent checks.
      throw new SourceGovernanceError();
    },
  };
}

function clientWithToken(env: Cloudflare.Env, timeoutMs: number, getToken: TokenSource | undefined, governed = false): HallMonitorClient | null {
  let transport: Transport;
  if (env.HALL_MONITOR !== undefined) {
    transport = serviceBindingTransport(env.HALL_MONITOR, getToken === undefined ? {} : { getToken });
  } else if (env.HALL_MONITOR_URL && getToken !== undefined) {
    transport = fetchTransport({ baseUrl: env.HALL_MONITOR_URL, getToken });
  } else {
    return null;
  }
  // Keep the pinned SDK and DTOs. Older receivers return 404 on the required route instead of
  // silently ignoring a JWT extension. There is deliberately no fallback to the legacy path.
  return createHallMonitorClient({ transport: governed ? {
    send(request) {
      return transport.send(request.method === "POST" && request.path === "/v1/evaluations"
        ? { ...request, path: "/v1/evaluations:governed" } : request);
    },
  } : transport, timeoutMs });
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
