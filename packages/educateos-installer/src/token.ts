import { EducateOsError } from "@educateos/contracts";

/**
 * How the installer got its Cloudflare credential.
 *
 * - `oauth`: the root's public OAuth client obtained an access token with the district owner's
 *   consent. Revoking the grant in the Cloudflare dashboard ends the installer's access.
 * - `district-run`: the district runs the installer itself (CLI or its own CI) with an API token
 *   it created and can delete.
 */
export type InstallMode = "oauth" | "district-run";

/**
 * Supplies the bearer token for each Cloudflare call. Asked on every call rather than once, so a
 * refreshed OAuth token is picked up and a revoked one is noticed at the next call.
 */
export interface TokenProvider {
  /** Which install mode the token belongs to. */
  readonly mode: InstallMode;
  /** The current bearer token. Never log or persist the result. */
  accessToken(): Promise<string>;
}

/** The environment variable a district-run install reads its API token from. */
export const DISTRICT_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";

/**
 * A district-run token provider reading an API token from the environment. Fails with
 * `unauthenticated` when the variable is unset, without echoing anything from the environment.
 */
export function districtRunTokenProvider(
  env: Readonly<Record<string, string | undefined>>,
  variable = DISTRICT_TOKEN_ENV,
): TokenProvider {
  return {
    mode: "district-run",
    async accessToken() {
      const token = env[variable];
      if (!token) throw new EducateOsError("unauthenticated", `${variable} is not set`);
      return token;
    },
  };
}

/** A token provider that always returns one token. For tests and short-lived callers. */
export function staticTokenProvider(mode: InstallMode, token: string): TokenProvider {
  return { mode, accessToken: async () => token };
}
