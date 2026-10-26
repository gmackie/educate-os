// Checks of the Worker's configuration and of who is calling, kept apart so the Worker and its
// district objects apply the same rules.
import type { Env } from "./env.ts";

/**
 * The redirect URIs every OIDC client is registered with, for one district: `OIDC_REDIRECT_URIS`,
 * comma-separated, `{slug}` replaced by the district's slug.
 */
export function redirectUrisOf(env: Env, slug: string): string[] {
  return (env.OIDC_REDIRECT_URIS ?? "")
    .split(",")
    .map((uri) => uri.trim().replaceAll("{slug}", slug))
    .filter((uri) => uri !== "");
}

/**
 * Why `OIDC_REDIRECT_URIS` is refused, or undefined when it is usable. Every URI must be https, and
 * none may be a Cloudflare Access callback: the fake issuers have no sign-in page (`login_hint`
 * names whoever the caller likes), so an Access team that trusted one as an identity provider would
 * let anyone into its applications as a synthetic person. A fake must never be an Access IdP.
 */
export function redirectUrisProblem(env: Env): string | undefined {
  for (const uri of redirectUrisOf(env, "slug")) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return `OIDC_REDIRECT_URIS has ${uri}, which is not a URL`;
    }
    if (url.protocol !== "https:") return `OIDC_REDIRECT_URIS has ${uri}, which is not https`;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host === "cloudflareaccess.com" || host.endsWith(".cloudflareaccess.com")) {
      return `OIDC_REDIRECT_URIS has ${uri}, a Cloudflare Access callback: the fakes must never be Access identity providers`;
    }
  }
  return undefined;
}

/** An IPv6 address's 16-bit groups, `::` expanded, or undefined for anything else. */
function ipv6Groups(address: string): string[] | undefined {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0]!;
  if (!bare.includes(":")) return undefined;
  const [head, tail, extra] = bare.split("::");
  if (extra !== undefined) return undefined;
  const part = (text: string | undefined) => (text === undefined || text === "" ? [] : text.split(":"));
  let groups = part(head);
  const end = part(tail);
  // A trailing embedded IPv4 address (`::ffff:192.0.2.1`) is two groups.
  const last = (end.length > 0 ? end : groups).at(-1);
  const embedded = last !== undefined && last.includes(".") ? 1 : 0;
  if (tail === undefined) {
    if (groups.length + embedded !== 8) return undefined;
  } else {
    const missing = 8 - groups.length - end.length - embedded;
    if (missing < 1) return undefined;
    groups = [...groups, ...Array<string>(missing).fill("0"), ...end];
  }
  if (!groups.slice(0, 4).every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  return groups;
}

/**
 * Who a request counts against for rate limits: its IPv4 address, or its IPv6 /64. One IPv6
 * subscriber usually holds a whole /64, so counting full addresses would let them make up as many
 * callers as they like.
 */
export function clientKeyOf(address: string | null): string {
  if (address === null || address === "") return "unknown";
  const groups = ipv6Groups(address);
  if (groups === undefined) return address;
  return `${groups.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16)).join(":")}::/64`;
}
