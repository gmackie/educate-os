// Adapted from PlayTrek `packages/api/src/jobs/interest-fact-investigation.ts`
// (`isSafeInterestFactSourceUrl`, `isPrivateIpv6`) at commit 7258e4347. Tightened for SchoolOS:
// https only, every IP literal refused rather than only private ranges, default port only,
// single-label and well-known loopback-resolving names refused, and a reason for each refusal.

/** Why an import URL was refused. Safe to show the caller: it names a rule, not a network fact. */
export type UrlRefusal =
  | "malformed"
  | "not-https"
  | "credentials-in-url"
  | "non-default-port"
  | "ip-literal"
  | "private-host";

/**
 * Hostname suffixes that name private, local or cloud-metadata hosts, or public wildcard DNS
 * services whose names resolve to whatever address they spell (`127.0.0.1.nip.io`).
 */
const PRIVATE_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "lan",
  "home",
  "corp",
  "intranet",
  "home.arpa",
  "in-addr.arpa",
  "ip6.arpa",
  "nip.io",
  "sslip.io",
  "xip.io",
  "localtest.me",
  "lvh.me",
] as const;

/** Exact hostnames of cloud instance-metadata services that are not covered by a suffix. */
const METADATA_HOSTS = new Set(["metadata.azure.com", "metadata.tencentyun.com", "instance-data.ec2.amazonaws.com"]);

/** Whether a WHATWG-parsed hostname is an IP literal. The parser has already turned `0x7f.1`, `2130706433` and friends into dotted IPv4. */
function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Checks a URL a district member asked SchoolOS to fetch, without DNS. The checks run on the
 * WHATWG-parsed form, which is what `fetch` will connect to, so encodings that a string check
 * would miss (`https://0x7f000001/`, `https://LOCALHOST./`) are caught.
 *
 * DNS is out of reach here, so a public name that resolves to a private address is not caught by
 * this check. On Workers, `fetch` cannot reach private networks; other runtimes must enforce
 * egress at the network layer as well.
 */
export function checkImportUrl(value: string): { ok: true; url: URL } | { ok: false; reason: UrlRefusal } {
  if (!URL.canParse(value)) return { ok: false, reason: "malformed" };
  const url = new URL(value);
  if (url.protocol !== "https:") return { ok: false, reason: "not-https" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials-in-url" };
  if (url.port !== "") return { ok: false, reason: "non-default-port" };
  if (isIpLiteral(url.hostname)) return { ok: false, reason: "ip-literal" };
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !hostname.includes(".")
    || METADATA_HOSTS.has(hostname)
    || PRIVATE_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))
  ) {
    return { ok: false, reason: "private-host" };
  }
  return { ok: true, url };
}
