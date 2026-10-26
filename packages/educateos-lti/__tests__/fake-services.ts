// A stand-in for a platform's LTI Advantage side: an OAuth 2 token endpoint that verifies the
// tool's client assertion against the tool JWKS, and NRPS and AGS endpoints that check the bearer
// token and its scopes. Everything is in memory and every request is recorded.
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { LTI_SCOPES, type LtiContextServices } from "../src/index.ts";
import type { FakePlatform } from "./fake-platform.ts";

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly body: string;
}

export interface FakeMember {
  user_id: string;
  roles: string[];
  status?: string;
  [extra: string]: unknown;
}

interface IssuedToken {
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

/** The LTI Advantage services of one fake platform. */
export class FakeServicePlatform {
  readonly platform: FakePlatform;
  readonly tokenUrl: string;
  readonly requests: RecordedRequest[] = [];
  /** Members per context ID. */
  readonly members = new Map<string, FakeMember[]>();
  /** Members per NRPS page. */
  pageSize = 50;
  /** Line items by URL, in creation order. */
  readonly lineItems = new Map<string, Record<string, unknown>>();
  /** Scores posted, by line item URL. */
  readonly scores: { lineItem: string; score: Record<string, unknown> }[] = [];
  /** Results returned per line item URL. */
  readonly results = new Map<string, Record<string, unknown>[]>();
  /** Seconds a token lives. */
  tokenLifetime = 3600;
  /** Scopes the token endpoint grants; by default whatever was asked for. */
  grantScopes: ((requested: string[]) => string[]) | undefined;
  /** Status to answer score posts with, once each. */
  readonly scoreFailures: number[] = [];
  /** Overrides an NRPS page's Link header. */
  linkOverride: ((page: number, contextId: string) => string | undefined) | undefined;
  /** A Link header for line item container pages, by request URL. */
  lineItemsLink: ((url: URL) => string | undefined) | undefined;
  readonly #toolJwks: () => { keys: JWK[] };
  readonly #now: () => number;
  readonly #tokens = new Map<string, IssuedToken>();
  readonly #usedJtis = new Set<string>();
  #tokenCounter = 0;
  #lineItemCounter = 0;

  constructor(platform: FakePlatform, toolJwks: () => { keys: JWK[] }, now: () => number) {
    this.platform = platform;
    this.tokenUrl = `${platform.issuer}/login/oauth2/token`;
    this.#toolJwks = toolJwks;
    this.#now = now;
  }

  /** The token requests the platform accepted. */
  get tokenRequests(): RecordedRequest[] {
    return this.requests.filter((request) => request.url === this.tokenUrl);
  }

  /** Withdraws every issued token, as a platform does when it rotates its token signing key. */
  revokeTokens(): void {
    this.#tokens.clear();
  }

  membershipsUrl(contextId: string): string {
    return `${this.platform.issuer}/api/lti/courses/${contextId}/names_and_roles`;
  }

  lineItemsUrl(contextId: string): string {
    return `${this.platform.issuer}/api/lti/courses/${contextId}/line_items`;
  }

  /** Context services as a launch would report them. */
  contextServices(contextId: string, agsScopes: readonly string[] = Object.values(LTI_SCOPES).filter((s) => s.includes("lti-ags"))): LtiContextServices {
    return {
      registration: { issuer: this.platform.issuer, clientId: this.platform.clientId },
      contextId,
      ags: { scopes: [...agsScopes], lineItemsUrl: this.lineItemsUrl(contextId) },
      nrps: { membershipsUrl: this.membershipsUrl(contextId) },
    };
  }

  /** Adds a line item directly, as if a teacher created it in the LMS. */
  addLineItem(contextId: string, item: Record<string, unknown>): string {
    this.#lineItemCounter += 1;
    const id = `${this.lineItemsUrl(contextId)}/${this.#lineItemCounter}`;
    this.lineItems.set(id, { ...item, id });
    return id;
  }

  owns(url: string): boolean {
    return url.startsWith(`${this.platform.issuer}/`);
  }

  async handle(request: Request): Promise<Response> {
    const body = await request.text();
    this.requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      body,
    });
    if (request.url === this.tokenUrl) return this.#token(body);
    const url = new URL(request.url);
    const path = url.pathname;

    const nrps = /^\/api\/lti\/courses\/([^/]+)\/names_and_roles$/.exec(path);
    if (nrps !== null && request.method === "GET") {
      return this.#authorized(request, [LTI_SCOPES.contextMembershipReadonly], () => this.#memberships(url, nrps[1]!));
    }
    const container = /^\/api\/lti\/courses\/([^/]+)\/line_items$/.exec(path);
    if (container !== null) {
      if (request.method === "POST") {
        return this.#authorized(request, [LTI_SCOPES.lineItem], () => {
          const id = this.addLineItem(container[1]!, JSON.parse(body) as Record<string, unknown>);
          return Response.json(this.lineItems.get(id), { status: 201 });
        });
      }
      return this.#authorized(request, [LTI_SCOPES.lineItem, LTI_SCOPES.lineItemReadonly], () => {
        const prefix = `${url.origin}${path}/`;
        const items = [...this.lineItems.values()].filter(
          (item) =>
            String(item.id).startsWith(prefix) &&
            (url.searchParams.get("resource_link_id") === null || item.resourceLinkId === url.searchParams.get("resource_link_id")),
        );
        const link = this.lineItemsLink?.(url);
        return Response.json(items, link === undefined ? {} : { headers: { link } });
      });
    }
    const item = /^(\/api\/lti\/courses\/[^/]+\/line_items\/\d+)(\/scores|\/results)?$/.exec(path);
    if (item !== null) {
      const itemUrl = `${url.origin}${item[1]}${url.search.replace(/[?&]user_id=[^&]*/, "")}`;
      if (item[2] === "/scores" && request.method === "POST") {
        return this.#authorized(request, [LTI_SCOPES.score], () => {
          const failure = this.scoreFailures.shift();
          if (failure !== undefined) return new Response("platform error", { status: failure });
          this.scores.push({ lineItem: itemUrl, score: JSON.parse(body) as Record<string, unknown> });
          return new Response(null, { status: 204 });
        });
      }
      if (item[2] === "/results") {
        return this.#authorized(request, [LTI_SCOPES.resultReadonly], () => {
          const userId = url.searchParams.get("user_id");
          const results = (this.results.get(itemUrl) ?? []).filter((result) => userId === null || result.userId === userId);
          return Response.json(results);
        });
      }
      return this.#authorized(request, [LTI_SCOPES.lineItem, LTI_SCOPES.lineItemReadonly], () => {
        const found = this.lineItems.get(itemUrl);
        return found === undefined ? new Response("not found", { status: 404 }) : Response.json(found);
      });
    }
    return new Response("not found", { status: 404 });
  }

  #memberships(url: URL, contextId: string): Response {
    const all = this.members.get(contextId) ?? [];
    const page = Number(url.searchParams.get("page") ?? "1");
    const members = all.slice((page - 1) * this.pageSize, page * this.pageSize);
    const headers = new Headers();
    const override = this.linkOverride?.(page, contextId);
    if (override !== undefined) headers.set("link", override);
    else if (page * this.pageSize < all.length) {
      headers.set("link", `<${this.membershipsUrl(contextId)}?page=${page + 1}>; rel="next", <${this.membershipsUrl(contextId)}>; rel="first"`);
    }
    return Response.json({ id: url.toString(), context: { id: contextId, title: "Biology" }, members }, { headers });
  }

  async #token(body: string): Promise<Response> {
    const form = new URLSearchParams(body);
    if (
      form.get("grant_type") !== "client_credentials" ||
      form.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
    ) {
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    try {
      const { payload } = await jwtVerify(form.get("client_assertion") ?? "", createLocalJWKSet(this.#toolJwks()), {
        algorithms: ["RS256"],
        issuer: this.platform.clientId,
        subject: this.platform.clientId,
        audience: this.tokenUrl,
        currentDate: new Date(this.#now()),
        requiredClaims: ["exp", "iat", "jti"],
      });
      if (this.#usedJtis.has(payload.jti!)) throw new Error("replayed assertion");
      this.#usedJtis.add(payload.jti!);
    } catch {
      return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    const requested = (form.get("scope") ?? "").split(" ").filter((scope) => scope.length > 0);
    const scopes = this.grantScopes?.(requested) ?? requested;
    this.#tokenCounter += 1;
    const token = `token-${this.#tokenCounter}`;
    this.#tokens.set(token, { scopes, expiresAt: this.#now() + this.tokenLifetime * 1000 });
    return Response.json({ access_token: token, token_type: "Bearer", expires_in: this.tokenLifetime, scope: scopes.join(" ") });
  }

  #authorized(request: Request, anyOf: readonly string[], respond: () => Response): Response {
    const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const issued = token === undefined ? undefined : this.#tokens.get(token);
    if (issued === undefined || issued.expiresAt <= this.#now()) return new Response("unauthorized", { status: 401 });
    if (!anyOf.some((scope) => issued.scopes.includes(scope))) return new Response("insufficient scope", { status: 403 });
    return respond();
  }
}

/** A fetch that routes to fake service platforms; anything else is a network failure. */
export function servicesFetch(platforms: readonly FakeServicePlatform[]): typeof fetch {
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const platform = platforms.find((candidate) => candidate.owns(request.url));
    if (platform === undefined) throw new TypeError(`no route to ${request.url}`);
    return platform.handle(request);
  };
  return fake as typeof fetch;
}
