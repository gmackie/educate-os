// Registers a freshly installed instance with the root's registry (roadmap §9.1 step 1, R01).
// The district's agent identity is generated here, written straight into the backend Worker as a
// secret, and used once to sign the registration; the ownership token the root returns goes the
// same way. The installer keeps neither: Worker secrets cannot be read back, so after this the
// district alone holds them. A root that is down or refuses does not undo the install.
import { SchoolOsError } from "@schoolos/contracts";
import {
  DistrictAgent,
  InMemorySequenceCounter,
  type InstanceId,
  RegistrationReceipt,
  type RegistrationDetails,
  type SignedEnvelope,
  SigningIdentity,
} from "@schoolos/fleet";
import type { CloudflareApi } from "./cloudflare-api.ts";
import { guarded } from "./plan.ts";

/** Backend secret holding the district agent's private key (a JWK). */
export const AGENT_KEY_SECRET = "SCHOOLOS_FLEET_AGENT_KEY";
/** Backend secret holding the ownership token from the root's registration receipt. */
export const OWNERSHIP_TOKEN_SECRET = "SCHOOLOS_FLEET_OWNERSHIP_TOKEN";

/**
 * Delivers a signed registration to the root and returns its reply. Injected so tests and the
 * district-run CLI choose the transport; the reply is parsed here, not trusted.
 */
export interface RegistryEndpoint {
  register(envelope: SignedEnvelope): Promise<unknown>;
}

/** A {@link RegistryEndpoint} that POSTs the envelope as JSON to one URL. */
export function httpRegistryEndpoint(url: string, doFetch: typeof fetch = fetch): RegistryEndpoint {
  return {
    async register(envelope) {
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope),
        });
      } catch {
        throw new SchoolOsError("unavailable", "registry unreachable");
      }
      if (!response.ok) {
        throw new SchoolOsError(response.status === 409 ? "conflict" : "unavailable", `registry returned HTTP ${response.status}`);
      }
      return await response.json();
    },
  };
}

/** How registration ended. */
export type RegistrationOutcome =
  | { status: "registered"; keyId: string }
  | { status: "already-registered" }
  /** The root was unreachable or failed. The install stands; run the installer again later. */
  | { status: "pending"; reason: string }
  /** The root already has this instance ID, but the district holds no ownership token for it. */
  | { status: "conflict"; operatorAction: string };

/** What registration needs. */
export interface RegistrationContext {
  api: CloudflareApi;
  accountId: string;
  instanceId: InstanceId;
  /** The backend Worker, which holds the agent's secrets. */
  backendScript: string;
  endpoint: RegistryEndpoint;
  details: RegistrationDetails;
  now?: () => Date;
}

/**
 * Registers the instance unless the backend already holds an ownership token. Idempotent: a re-run
 * after success does nothing, and a re-run after an interrupted attempt generates a fresh key,
 * because the earlier one was never read back and cannot be reused.
 */
export async function registerWithFleet(context: RegistrationContext): Promise<RegistrationOutcome> {
  const { api, accountId, backendScript } = context;
  const secrets = await guarded(() => api.listWorkerSecrets(accountId, backendScript));
  if (secrets.includes(OWNERSHIP_TOKEN_SECRET)) return { status: "already-registered" };

  const identity = await SigningIdentity.generate();
  const jwk = JSON.stringify(await identity.exportJwk());
  await guarded(() => api.putWorkerSecret(accountId, backendScript, AGENT_KEY_SECRET, jwk));

  const agent = new DistrictAgent({
    identity,
    instanceId: context.instanceId,
    // Registration carries no sequence number; the deployed agent keeps the durable counter.
    sequence: new InMemorySequenceCounter(),
    sharesAggregateSpend: false,
    ...(context.now ? { now: context.now } : {}),
  });
  const envelope = await agent.register(context.details);

  let reply: unknown;
  try {
    reply = await context.endpoint.register(envelope);
  } catch (error) {
    if (error instanceof SchoolOsError && error.code === "conflict") {
      return {
        status: "conflict",
        operatorAction: "The root already has this instance ID registered. Ask SchoolOS support to confirm ownership, or install under a new instance ID.",
      };
    }
    return { status: "pending", reason: error instanceof SchoolOsError ? `registry-${error.code}` : "registry-unreachable" };
  }
  const parsed = RegistrationReceipt.safeParse(reply);
  if (!parsed.success) return { status: "pending", reason: "registry-reply-invalid" };
  const receipt = parsed.data;
  if (receipt.instanceId !== context.instanceId || receipt.keyId !== identity.keyId) {
    return { status: "pending", reason: "registry-receipt-mismatch" };
  }
  await guarded(() => api.putWorkerSecret(accountId, backendScript, OWNERSHIP_TOKEN_SECRET, receipt.ownershipToken));
  return { status: "registered", keyId: receipt.keyId };
}
