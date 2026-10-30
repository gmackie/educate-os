// Redirects from a district's old hostnames to its one origin (ADR-0014 §7, SCHO-259). At the
// cutover the old hostnames stay attached to the router, and `LEGACY_HOSTS` maps each one to the URL
// prefix it moved to, for example
//
//   { "schoolos.gmac.io": "https://northfield.educateos.io/ai",
//     "district.schoolos.gmac.io": "https://northfield.educateos.io" }
//
// A request on a listed hostname is answered with a redirect to the prefix plus its path and query,
// and reaches no other Worker, so nothing is served on an old hostname but `/healthz` (answered
// first, in index.ts) and redirects. Two refinements:
//
//   - `/gatekeeper/*` keeps its root path on the target origin. Gatekeepers stay at the root of a
//     district origin, so their OAuth callbacks are not moved under the Workshop's `/ai`.
//   - GET and HEAD get a 301, as the ADR says. Any other method gets a 308, which keeps the method
//     and body: a 301 lets a browser turn a POST (an LTI launch, an API call) into a GET.
//
// Unset, no hostname redirects. An invalid value fails closed: every request but `/healthz` is
// answered with a 500, so a bad deploy is visible instead of serving old hostnames unredirected.

/** The old hostnames, by lowercase hostname, and the URL prefix each now redirects to. */
export type LegacyHosts = ReadonlyMap<string, URL>;

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Parses `LEGACY_HOSTS`. Throws, naming the problem but no value, when it is invalid. */
export function parseLegacyHosts(text: string | undefined): LegacyHosts {
  const hosts = new Map<string, URL>();
  if (text === undefined || text.trim() === "") return hosts;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("LEGACY_HOSTS is not JSON");
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("LEGACY_HOSTS must be an object of hostname to URL prefix");
  }
  for (const [host, target] of Object.entries(json)) {
    if (!HOSTNAME.test(host)) throw new Error(`LEGACY_HOSTS has an invalid hostname: ${host}`);
    if (typeof target !== "string") throw new Error(`LEGACY_HOSTS[${host}] must be a URL`);
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new Error(`LEGACY_HOSTS[${host}] must be a URL`);
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" ||
        url.hash !== "" || target.endsWith("/")) {
      throw new Error(`LEGACY_HOSTS[${host}] must be an https URL with no query or trailing slash`);
    }
    if (url.hostname === host) throw new Error(`LEGACY_HOSTS[${host}] redirects to itself`);
    hosts.set(host, url);
  }
  return hosts;
}

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/** The redirect for `req` when its hostname is a legacy one, else undefined. */
export function legacyRedirect(req: Request, hosts: LegacyHosts): Response | undefined {
  const url = new URL(req.url);
  const target = hosts.get(url.hostname);
  if (!target) return undefined;
  const prefix = underPrefix(url.pathname, "/gatekeeper") ? "" : target.pathname.replace(/\/$/, "");
  const location = target.origin + prefix + url.pathname + url.search;
  const status = req.method === "GET" || req.method === "HEAD" ? 301 : 308;
  return new Response(null, { status, headers: { location, "cache-control": "no-store" } });
}
