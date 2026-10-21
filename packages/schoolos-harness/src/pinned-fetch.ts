// Resolve-then-connect egress for the Content Studio outside Workers (SCHO-80). On Workers, `fetch`
// cannot reach private networks, so the studio's URL checks suffice there. Node's `fetch` can reach
// anything the host can, and resolves names itself after the studio has checked them, so a public
// name that resolves to a private address (or is rebound to one between check and connect) would
// get through. This fetch resolves the name once, refuses unless every address is public, and then
// connects to the address it checked, with SNI and the Host header set to the name so TLS still
// verifies the certificate against it. Inject it as the studio's `fetch` in Node only. It is a
// separate entry point (`@schoolos/harness/pinned-fetch`) so that browser consumers of the harness's
// main entry never compile Node's modules.
import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { checkImportUrl, type ImportFetch, isPublicAddress } from "@schoolos/content-studio";
import { SchoolOsError } from "@schoolos/contracts";

/** Resolves a host name to every address it has. */
export type ResolveHost = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** One request to send over a connection pinned to a checked address. */
export interface PinnedRequest {
  /** The IP address to connect to: one that was checked to be public. */
  address: string;
  port: number;
  /** The host name, sent as TLS SNI and used to verify the server's certificate. */
  servername: string;
  /** The `Host` header: the name, with a port only when the URL had one. */
  host: string;
  method: string;
  /** The path and query. */
  path: string;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}

/** Sends a pinned request. {@link httpsTransport} is the real one. */
export type PinnedTransport = (request: PinnedRequest) => Promise<Response>;

const resolveAll: ResolveHost = (hostname) => lookup(hostname, { all: true, verbatim: true });

/**
 * A Content Studio {@link ImportFetch} for Node that pins each connection to an address it checked.
 * The URL must pass the studio's own checks first; every address the name resolves to must be
 * public, or the request is refused before any connection is made.
 *
 * @throws SchoolOsError `policy-violation` for a refused URL or a name with a non-public address,
 *   and `unavailable` when the name does not resolve.
 */
export function createPinnedEgressFetch(options: { resolve?: ResolveHost; transport?: PinnedTransport } = {}): ImportFetch {
  const resolve = options.resolve ?? resolveAll;
  const transport = options.transport ?? httpsTransport();
  return async (url, init) => {
    const checked = checkImportUrl(url);
    if (!checked.ok) throw new SchoolOsError("policy-violation", `the URL was refused (${checked.reason})`);
    const target = checked.url;
    // The WHATWG parser keeps IPv6 brackets in `hostname`; checkImportUrl has already refused IP literals.
    const hostname = target.hostname.replace(/\.$/, "");
    let addresses: { address: string }[];
    try {
      addresses = await resolve(hostname);
    } catch {
      throw new SchoolOsError("unavailable", "the source's name could not be resolved");
    }
    if (addresses.length === 0) throw new SchoolOsError("unavailable", "the source's name could not be resolved");
    // Every address, not just the one used: a name answering with a mix is not trusted at all.
    if (addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new SchoolOsError("policy-violation", "the source's name resolves to a private address");
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      if (name !== "host") headers[name] = value;
    });
    return transport({
      address: addresses[0]!.address,
      port: target.port === "" ? 443 : Number(target.port),
      servername: hostname,
      host: target.host,
      method: init.method ?? "GET",
      path: `${target.pathname}${target.search}`,
      headers,
      signal: init.signal ?? undefined,
    });
  };
}

/**
 * The real {@link PinnedTransport}: one HTTPS request over Node's `https`, connected to
 * `request.address` with SNI and certificate verification against `request.servername`. Redirects
 * are returned, never followed, so the studio checks every hop. `tls` adds TLS options, such as a
 * test's own certificate authority; it cannot turn verification off.
 */
export function httpsTransport(tls: Pick<RequestOptions, "ca"> = {}): PinnedTransport {
  return (request) => new Promise<Response>((resolve, reject) => {
    const outgoing = httpsRequest({
      ...tls,
      host: request.address,
      port: request.port,
      servername: request.servername,
      method: request.method,
      path: request.path,
      headers: { ...request.headers, host: request.host },
      signal: request.signal,
      // No agent: a pooled connection to the same address could be reused under another name.
      agent: false,
      rejectUnauthorized: true,
    }, (incoming) => resolve(toResponse(incoming, request.method)));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function toResponse(incoming: IncomingMessage, method: string): Response {
  const headers = new Headers();
  const raw = incoming.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) headers.append(raw[i]!, raw[i + 1]!);
  const status = incoming.statusCode ?? 502;
  const empty = method === "HEAD" || status === 204 || status === 304;
  if (empty) incoming.resume();
  const body = empty ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>);
  return new Response(body, { status, headers });
}
