// Reads one AI Gateway log by ID through the Cloudflare API (SCHO-134), for the cost the gateway
// recorded. Only cost and token counts are read: a log can hold prompts, and nothing else is kept.

import { z } from "zod";

/** The fields of an AI Gateway log the guard reads. */
export interface GatewayLog {
  /** What the gateway says the request cost, in US dollars; absent or null until it knows. */
  cost?: number | string | null;
  /** Input tokens. */
  tokens_in?: number | null;
  /** Output tokens. */
  tokens_out?: number | null;
}

/** Looks up AI Gateway logs. */
export interface GatewayLogSource {
  /** The log with this ID, or `null` when the gateway has none (yet). Throws when it cannot be asked. */
  log(gatewayLogId: string): Promise<GatewayLog | null>;
}

const LogResponse = z.object({
  success: z.boolean().optional(),
  result: z.object({
    cost: z.union([z.number().nonnegative(), z.string().max(40), z.null()]).optional(),
    tokens_in: z.int().nonnegative().nullable().optional(),
    tokens_out: z.int().nonnegative().nullable().optional(),
  }),
});

/** How long one log lookup may take before the guard falls back to an estimate. */
const LOOKUP_TIMEOUT_MS = 3_000;

/** Where the guard's AI Gateway lives, and the API token that may read its logs. */
export interface GatewayLogCredentials {
  /** The Cloudflare account that owns the gateway. */
  accountId: string;
  /** The gateway's ID. */
  gatewayId: string;
  /** An API token with AI Gateway read permission. */
  apiToken: string;
}

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** A {@link GatewayLogSource} over the Cloudflare API, through `fetcher`. */
export function cloudflareGatewayLogs(credentials: GatewayLogCredentials, fetcher: typeof fetch = fetch): GatewayLogSource {
  const { accountId, gatewayId, apiToken } = credentials;
  if (!PATH_SEGMENT.test(accountId) || !PATH_SEGMENT.test(gatewayId)) throw new Error("AI Gateway account or gateway ID is malformed");
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/logs/`;
  return {
    async log(gatewayLogId) {
      if (!PATH_SEGMENT.test(gatewayLogId)) return null;
      const response = await fetcher(base + encodeURIComponent(gatewayLogId), {
        headers: { authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`AI Gateway logs API answered ${response.status}`);
      const parsed = LogResponse.safeParse(await response.json());
      if (!parsed.success) throw new Error("AI Gateway logs API answered with an unexpected shape");
      return parsed.data.result;
    },
  };
}

/**
 * The deployment's AI Gateway log source, or `null` when it configures none. All three of
 * `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID` and `AI_GATEWAY_LOGS_TOKEN` must be set.
 */
export function gatewayLogSource(env: Pick<Cloudflare.Env, "AI_GATEWAY_ACCOUNT_ID" | "AI_GATEWAY_ID" | "AI_GATEWAY_LOGS_TOKEN">): GatewayLogSource | null {
  const { AI_GATEWAY_ACCOUNT_ID: accountId, AI_GATEWAY_ID: gatewayId, AI_GATEWAY_LOGS_TOKEN: apiToken } = env;
  if (!accountId || !gatewayId || !apiToken) return null;
  return cloudflareGatewayLogs({ accountId, gatewayId, apiToken });
}
