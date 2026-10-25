// Adapted from PlayTrek `packages/api/src/jobs/interest-fact-investigation.ts`
// (`isSafeInterestFactSourceUrl`, `isPrivateIpv6`) at commit 7258e4347. Tightened for EducateOS:
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
 * Checks a URL a district member asked EducateOS to fetch, without DNS. The checks run on the
 * WHATWG-parsed form, which is what `fetch` will connect to, so encodings that a string check
 * would miss (`https://0x7f000001/`, `https://LOCALHOST./`) are caught.
 *
 * DNS is out of reach here, so a public name that resolves to a private address is not caught by
 * this check. On Workers, `fetch` cannot reach private networks. Other runtimes must pin egress
 * after DNS with {@link isPublicAddress}, as the harness's `createPinnedEgressFetch` does.
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

/** IPv4 ranges that are not the public internet: private, shared, loopback, link-local, documentation, benchmarking, multicast and reserved. */
const NON_PUBLIC_V4: readonly [number, number][] = [
  [0x00000000, 8], // "this network"
  [0x0a000000, 8], // private
  [0x64400000, 10], // carrier-grade NAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local, including cloud metadata at 169.254.169.254
  [0xac100000, 12], // private
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // documentation
  [0xc0586300, 24], // 6to4 relay anycast
  [0xc0a80000, 16], // private
  [0xc6120000, 15], // benchmarking
  [0xc6336400, 24], // documentation
  [0xcb007100, 24], // documentation
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved and broadcast
];

function parseV4(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return undefined;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}

const groups = (part: string) => (part === "" ? [] : part.split(":"));

function parseV6(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  // An embedded IPv4 tail (`::ffff:1.2.3.4`) is rewritten as the two groups it stands for.
  const v4 = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4 !== null) {
    const value = parseV4(v4[1]!);
    if (value === undefined) return undefined;
    text = `${text.slice(0, -v4[1]!.length)}${Math.floor(value / 0x10000).toString(16)}:${(value % 0x10000).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if ([...head, ...tail].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const zeros = Array<number>(halves.length === 2 ? missing : 0).fill(0);
  return [...head.map((part) => Number.parseInt(part, 16)), ...zeros, ...tail.map((part) => Number.parseInt(part, 16))];
}

/**
 * Whether a resolved IP address is on the public internet, and so may be connected to for an
 * import. IPv4 is public unless it is in a private, shared, loopback, link-local, documentation,
 * benchmarking, multicast or reserved range. IPv6 is public only in global unicast (`2000::/3`),
 * outside the protocol, documentation and 6to4 blocks; an IPv4-mapped address is judged as the
 * IPv4 address it maps. Anything that does not parse is not public.
 *
 * This is the check a runtime that can reach private networks applies after DNS: Workers' `fetch`
 * cannot reach them, but Node can (see the harness's pinned egress fetch).
 */
export function isPublicAddress(address: string): boolean {
  const v4 = parseV4(address);
  if (v4 !== undefined) return !NON_PUBLIC_V4.some(([base, bits]) => Math.floor(v4 / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
  const v6 = parseV6(address);
  if (v6 === undefined) return false;
  const [a, b] = v6 as [number, number];
  // IPv4-mapped (`::ffff:a.b.c.d`): judged as the IPv4 address.
  if (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff) return isPublicAddress(`${v6[6]! >> 8}.${v6[6]! & 0xff}.${v6[7]! >> 8}.${v6[7]! & 0xff}`);
  if ((a & 0xe000) !== 0x2000) return false; // only global unicast
  if (a === 0x2001 && b < 0x0200) return false; // IETF protocol assignments, including Teredo
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x2002) return false; // 6to4, which embeds an arbitrary IPv4 address
  return true;
}
