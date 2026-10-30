// Reaching Hall Monitor to screen students' discussion posts (SCHO-305): the HTTPS client, with a
// fresh service token on every attempt, built from the Worker's deploy inputs. The AI call guard
// reaches the same service the same way (packages/educateos-ai-guard/src/hall-monitor.ts).
import { createHallMonitorClient, fetchTransport, serviceTokenSource } from "@gmacko/hall-monitor-client";
import type { DiscussionScreening, DiscussionScreeningSettings } from "@educateos/discussions";

/** How long one evaluation may take before the post is refused as screening-unavailable. */
const TIMEOUT_MS = 10_000;

/** The deploy inputs Hall Monitor is reached with. */
export interface HallMonitorInputs {
  /** `HALL_MONITOR_URL`: Hall Monitor's https origin. */
  url: string | undefined;
  /** `HALL_MONITOR_SIGNING_KEY`: a private Ed25519 or P-256 JWK, as JSON. */
  signingKey: string | undefined;
  /** `HALL_MONITOR_ISSUER`: the issuer Hall Monitor trusts these tokens from. */
  issuer: string | undefined;
  /** `HALL_MONITOR_AUDIENCE`, defaulting to `hall-monitor`. */
  audience: string | undefined;
  /** The fetch Hall Monitor is called with. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** A Hall Monitor that refuses every evaluation, so screening fails closed. */
const UNREACHABLE: DiscussionScreening["hallMonitor"] = {
  evaluate: async () => {
    throw new Error("Hall Monitor is not configured for discussion screening");
  },
};

/**
 * The client posts are screened with under `settings`, or one that refuses every post when Hall
 * Monitor cannot be reached with what is configured. Never returns a client that allows unscreened.
 */
export function discussionHallMonitor(inputs: HallMonitorInputs, settings: DiscussionScreeningSettings): DiscussionScreening["hallMonitor"] {
  if (!inputs.url || !inputs.signingKey || !inputs.issuer) return UNREACHABLE;
  let jwk: JsonWebKey & { kid?: string };
  try {
    jwk = JSON.parse(inputs.signingKey) as JsonWebKey & { kid?: string };
  } catch {
    return UNREACHABLE;
  }
  const algorithm = jwk.kty === "OKP" && jwk.crv === "Ed25519" ? "EdDSA" : jwk.kty === "EC" && jwk.crv === "P-256" ? "ES256" : undefined;
  if (algorithm === undefined || jwk.d === undefined) return UNREACHABLE;
  const { kid, ...material } = jwk;
  const issuer = inputs.issuer;
  const audience = inputs.audience || "hall-monitor";
  // Imported on first use, and again after a failure, so a bad key refuses posts instead of
  // rejecting with nobody listening.
  let source: Promise<() => Promise<string>> | undefined;
  const getToken = async () => {
    source ??= crypto.subtle.importKey("jwk", material,
        algorithm === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
      .then((privateKey) => serviceTokenSource({
        issuer, audience, tenant: settings.tenantId, scope: ["evaluate"], algorithm,
        privateKey, ...(kid === undefined ? {} : { keyId: kid }),
      }));
    try {
      return await (await source)();
    } catch (error) {
      source = undefined;
      throw error;
    }
  };
  try {
    const transport = fetchTransport({ baseUrl: inputs.url, getToken, ...(inputs.fetch === undefined ? {} : { fetch: inputs.fetch }) });
    return createHallMonitorClient({ transport, timeoutMs: TIMEOUT_MS });
  } catch {
    // An unusable URL (not https, say) refuses posts rather than stopping the district.
    return UNREACHABLE;
  }
}
