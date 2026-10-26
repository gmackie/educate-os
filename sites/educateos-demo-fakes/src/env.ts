// The Worker's configuration. Secrets and vars only; the district object is reached through
// `ctx.exports`, so there are no bindings.
import { DEFAULT_PUBLIC_ORIGIN } from "./layout.ts";

/** What the Worker and its district objects read from the environment. */
export interface Env {
  /**
   * Secret. Every credential of every fake is derived from it (see credentials.ts). Unset or under
   * 32 characters, the fakes answer 503 and only `/healthz` and `/` are served.
   */
  readonly FAKES_SECRET?: string;
  /**
   * The audience tag of the Cloudflare Access application in front of `/_admin/*`. Unset, every
   * admin request is refused.
   */
  readonly ADMIN_ACCESS_AUD?: string;
  /** The public origin the fakes' URLs are built on. Defaults to https://fakes.demo.educateos.io. */
  readonly PUBLIC_ORIGIN?: string;
  /**
   * The redirect URIs every OIDC client is registered with, comma-separated, exact-match.
   * `{slug}` in one is replaced by the district's slug.
   */
  readonly OIDC_REDIRECT_URIS?: string;
  /** Requests one client IP may make to one district's fakes per minute. Default 600. */
  readonly RATE_LIMIT_PER_MINUTE?: string;
}

/** The public origin, without a trailing slash. */
export function publicOrigin(env: Env): string {
  return (env.PUBLIC_ORIGIN ?? DEFAULT_PUBLIC_ORIGIN).replace(/\/+$/, "");
}
