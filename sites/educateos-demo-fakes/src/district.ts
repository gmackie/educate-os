// One demo district's fakes, in one Durable Object named by the district's slug. The fakes live in
// the object's memory, built from the district's seed on first use; an evicted or restarted object
// builds them again, so their state (issued tokens, codes, faults, a OneRoster upsert, an AGS score)
// starts over. Two things are stored so a restart is invisible to a configured district: each
// issuer's and platform's signing key (so JWKS and `kid`s stay the same) and the LTI tools registered
// with each platform (so a district's registration outlives the object). Credentials are derived
// from the secret, so they need no storing.
//
// The object also holds the public rate limit: requests per client IP per minute, counted in memory.
import { DurableObject } from "cloudflare:workers";
import { CLASSROOM_SCOPES, generatePlatformKey, type FaultSpec, type PlatformKey } from "@educateos/provider-fakes";
import type { DemoDistrictSlug } from "@educateos/fixtures";
import type { JWK } from "jose";
import { InputError, jsonBody, parseClassroomToken, parseFault, parseLaunch, parseRegistration, parseTool } from "./admin-input.ts";
import { deriveCredentials, secretUsable } from "./credentials.ts";
import { publicOrigin, type Env } from "./env.ts";
import { CLIENT_HEADER, buildFakes, fakeFor, fakesOf, storedTool, type DistrictFakes, type StoredTool } from "./fakes.ts";
import { baseUrlOf, districtOf, publicTarget, vendorsOf, type LtiFlavourName, type Vendor } from "./layout.ts";

/** A signing key as stored: its `kid` and both halves as JWKs. */
interface StoredKey {
  readonly kid: string;
  readonly privateJwk: JWK;
  readonly publicJwk: JWK;
}

/** A fault an operator injected, and how to take it out again. */
interface InjectedFault {
  readonly id: string;
  readonly vendor: Vendor | undefined;
  readonly fault: FaultSpec;
  readonly remove: () => void;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

const notFound = () => json({ error: "not_found" }, 404);

/** Per-key request counts in fixed one-minute windows. */
export class MinuteLimiter {
  readonly #limit: number;
  readonly #counts = new Map<string, number>();
  #window = -1;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Counts one request for `key`: undefined when allowed, or the seconds until the window turns. */
  take(key: string, now: number): number | undefined {
    const window = Math.floor(now / 60_000);
    if (window !== this.#window) {
      // A new minute: every count starts again, and the map holds only this minute's callers.
      this.#counts.clear();
      this.#window = window;
    }
    const count = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, count);
    return count > this.#limit ? Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000)) : undefined;
  }
}

/** The redirect URIs OIDC clients are registered with, for one district. */
export function redirectUrisOf(env: Env, slug: string): string[] {
  return (env.OIDC_REDIRECT_URIS ?? "")
    .split(",")
    .map((uri) => uri.trim().replaceAll("{slug}", slug))
    .filter((uri) => uri !== "");
}

/** One demo district's fakes. */
export class DemoFakesDistrict extends DurableObject<Env> {
  #fakes: Promise<DistrictFakes> | undefined;
  #slug: DemoDistrictSlug | undefined;
  readonly #faults = new Map<string, InjectedFault>();
  readonly #limiter: MinuteLimiter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const limit = Number(env.RATE_LIMIT_PER_MINUTE ?? "600");
    this.#limiter = new MinuteLimiter(Number.isInteger(limit) && limit > 0 ? limit : 600);
  }

  /** How a platform fetches a tool's JWKS. The tests replace it. */
  protected toolFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return fetch(input, init);
  }

  /** Serves one public request to the district's fakes, from the client at `client` (its IP). */
  async serve(slug: string, request: Request, client: string): Promise<Response> {
    const retryAfter = this.#limiter.take(client, Date.now());
    if (retryAfter !== undefined) return json({ error: "rate_limited", error_description: "Too many requests from this address." }, 429, { "retry-after": String(retryAfter) });
    const fakes = await this.#district(slug);
    if (fakes === undefined) return json({ error: "not_configured" }, 503);
    const url = new URL(request.url);
    const target = publicTarget(url.pathname);
    if (target === undefined || target.district.slug !== fakes.slug) return notFound();
    const fake = fakeFor(fakes, target.vendor, url.pathname);
    if (fake === undefined) return notFound();
    // The caller's address, for the Clever fake's per-client budget. Set here, never taken from
    // the caller.
    const headers = new Headers(request.headers);
    headers.set(CLIENT_HEADER, client);
    let response: Response;
    try {
      response = await fake.handle(new Request(request, { headers }));
    } catch (error) {
      // A fake throws only for a network-error fault, which the admin surface does not offer, or
      // a bug; neither should surface as a Worker exception.
      console.error(JSON.stringify({ event: "fake.threw", slug: fakes.slug, vendor: target.vendor, error: String(error) }));
      return json({ error: "fake_failed" }, 502);
    }
    // Dynamic Registration adds a tool: store it, so the registration outlives this object.
    const flavour = target.vendor === "lti/canvas" ? "canvas" : target.vendor === "lti/schoology" ? "schoology" : undefined;
    const platform = flavour === undefined ? undefined : fakes.lti[flavour];
    if (flavour !== undefined && platform !== undefined && request.method === "POST" && `${url.origin}${url.pathname}` === platform.flavour.registrationEndpoint && response.ok) {
      await this.#storeTools(flavour, fakes);
    }
    return response;
  }

  /** Serves one admin request. The Worker has verified its Access assertion already. */
  async admin(slug: string, request: Request): Promise<Response> {
    const fakes = await this.#district(slug);
    if (fakes === undefined) return json({ error: "not_configured", error_description: "FAKES_SECRET is unset or too short." }, 503);
    const path = new URL(request.url).pathname.split("/").slice(3).join("/");
    const method = request.method;
    try {
      if (path === "" && method === "GET") return json(this.#status(fakes));
      if (path === "credentials" && method === "GET") return json(this.#credentials(fakes));
      if (path === "reset" && method === "POST") return json(await this.#reset(slug, new URL(request.url).searchParams.get("registrations") === "clear"));
      if (path === "faults" && method === "GET") return json({ faults: this.#faultList() });
      if (path === "faults" && method === "POST") return json(this.#inject(fakes, await jsonBody(request)), 201);
      if (path === "faults" && method === "DELETE") return json(this.#clearFaults(fakes));
      if (path.startsWith("faults/") && method === "DELETE") return this.#removeFault(path.slice("faults/".length));
      if (path === "classroom/tokens" && method === "POST") return this.#classroomToken(fakes, await jsonBody(request));
      const lti = /^lti\/(canvas|schoology)\/(tools|registrations|launches)$/.exec(path);
      if (lti !== null) return await this.#lti(fakes, lti[1] as LtiFlavourName, lti[2]!, method, request);
    } catch (error) {
      if (error instanceof InputError) return json({ error: "invalid_request", error_description: error.message }, 400);
      // The fakes throw plain Errors for a launch naming an unknown person, section or tool.
      if (error instanceof Error && /^no |is not in section|is already registered|does not support/.test(error.message)) {
        return json({ error: "invalid_request", error_description: error.message }, 400);
      }
      throw error;
    }
    return notFound();
  }

  // ── Building ─────────────────────────────────────────────────────

  #district(slug: string): Promise<DistrictFakes | undefined> {
    const district = districtOf(slug);
    // One object per district: a slug other than the first this object served is refused.
    if (district === undefined || (this.#slug !== undefined && this.#slug !== district.slug)) return Promise.resolve(undefined);
    if (!secretUsable(this.env.FAKES_SECRET)) return Promise.resolve(undefined);
    this.#slug = district.slug;
    if (this.#fakes === undefined) {
      const building = this.#build(district.slug);
      this.#fakes = building;
      // A failed build is not kept: the next request tries again.
      building.catch(() => {
        if (this.#fakes === building) this.#fakes = undefined;
      });
    }
    return this.#fakes;
  }

  async #build(slug: DemoDistrictSlug): Promise<DistrictFakes> {
    const vendors = vendorsOf(districtOf(slug)!);
    return buildFakes({
      slug,
      origin: publicOrigin(this.env),
      vendors,
      credentials: await deriveCredentials(this.env.FAKES_SECRET!, slug, vendors),
      redirectUris: redirectUrisOf(this.env, slug),
      key: (name) => this.#key(name),
      tools: async (flavour) => (await this.ctx.storage.get<StoredTool[]>(`lti:${flavour}:tools`)) ?? [],
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => this.toolFetch(input, init)) as typeof fetch,
    });
  }

  /** A stored signing key, made and stored the first time it is asked for. */
  async #key(name: string): Promise<PlatformKey> {
    const storageKey = `key:${name}`;
    let stored = await this.ctx.storage.get<StoredKey>(storageKey);
    if (stored === undefined) {
      const fresh = await generatePlatformKey();
      stored = {
        kid: `${name.replace(":", "-")}-${crypto.randomUUID().slice(0, 8)}`,
        privateJwk: (await crypto.subtle.exportKey("jwk", fresh.privateKey)) as JWK,
        publicJwk: fresh.publicJwk,
      };
      await this.ctx.storage.put(storageKey, stored);
    }
    const privateKey = (await crypto.subtle.importKey("jwk", stored.privateJwk as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])) as CryptoKey;
    return { kid: stored.kid, privateKey, publicJwk: stored.publicJwk };
  }

  async #storeTools(flavour: LtiFlavourName, fakes: DistrictFakes): Promise<StoredTool[]> {
    const tools = [...(fakes.lti[flavour]?.tools.values() ?? [])].map(storedTool);
    await this.ctx.storage.put(`lti:${flavour}:tools`, tools);
    return tools;
  }

  // ── Admin ────────────────────────────────────────────────────────

  #status(fakes: DistrictFakes) {
    return {
      slug: fakes.slug,
      fakes: Object.fromEntries(fakes.vendors.map((vendor) => [vendor, baseUrlOf(fakes.origin, fakes.slug, vendor)])),
      faults: this.#faultList(),
      lti: Object.fromEntries(Object.entries(fakes.lti).map(([name, platform]) => [name, { tools: [...platform.tools.values()].map((t) => ({ clientId: t.clientId, deploymentIds: t.deploymentIds, name: t.name })) }])),
    };
  }

  #credentials(fakes: DistrictFakes) {
    const { credentials: c, origin, slug } = fakes;
    const base = (vendor: Vendor) => baseUrlOf(origin, slug, vendor);
    const oidc = (vendor: "clever" | "classlink" | "google", client: { clientId: string; clientSecret: string } | undefined) => {
      const fake = fakes.oidc[vendor];
      if (fake === undefined || client === undefined) return undefined;
      const p = fake.preset;
      return {
        issuer: p.issuer,
        discoveryUrl: fake.discoveryUrl,
        authorizationEndpoint: p.authorizationEndpoint,
        tokenEndpoint: p.tokenEndpoint,
        jwksUri: p.jwksUri,
        userinfoEndpoint: p.userinfoEndpoint,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUris: fakes.redirectUris,
      };
    };
    return {
      slug,
      ...(c.clever === undefined ? {} : { clever: { baseUrl: base("clever"), dataApi: `${base("clever")}/v3.1`, districtToken: c.clever.districtToken, oidc: oidc("clever", c.clever.oidc) } }),
      ...(c.classlink === undefined ? {} : { classlink: { oidc: oidc("classlink", c.classlink.oidc) } }),
      ...(c.google === undefined ? {} : { google: { oidc: oidc("google", c.google.oidc) } }),
      ...(fakes.oneroster === undefined || c.oneroster === undefined
        ? {}
        : { oneroster: { baseUrl: fakes.oneroster.baseUrl, rosteringUrl: fakes.oneroster.rosteringUrl, tokenUrl: fakes.oneroster.tokenUrl, clientId: c.oneroster.clientId, clientSecret: c.oneroster.clientSecret } }),
      ...(fakes.classroom === undefined ? {} : { classroom: { baseUrl: `${base("classroom")}/v1`, tokens: "Google sign-in access tokens granted Classroom scopes, or POST classroom/tokens" } }),
      ...(Object.keys(fakes.lti).length === 0
        ? {}
        : {
            lti: Object.fromEntries(Object.entries(fakes.lti).map(([name, platform]) => {
              const f = platform.flavour;
              return [name, {
                issuer: f.issuer,
                authorizationEndpoint: f.authorizationEndpoint,
                tokenEndpoint: f.tokenEndpoint,
                jwksUri: f.jwksUri,
                ...(f.openidConfigurationUrl === undefined ? {} : { openidConfigurationUrl: f.openidConfigurationUrl, registrationEndpoint: f.registrationEndpoint }),
                tools: [...platform.tools.values()].map((t) => ({ clientId: t.clientId, deploymentIds: t.deploymentIds, name: t.name, redirectUris: t.redirectUris })),
              }];
            })),
          }),
    };
  }

  async #reset(slug: string, clearRegistrations: boolean) {
    if (clearRegistrations) await this.ctx.storage.delete(["lti:canvas:tools", "lti:schoology:tools"]);
    this.#faults.clear();
    this.#fakes = undefined;
    const fakes = await this.#district(slug);
    return { reset: true, registrationsCleared: clearRegistrations, ...(fakes === undefined ? {} : this.#status(fakes)) };
  }

  #faultList() {
    return [...this.#faults.values()].map(({ id, vendor, fault }) => ({ id, vendor: vendor ?? "all", ...fault }));
  }

  #inject(fakes: DistrictFakes, body: Record<string, unknown>) {
    const { vendor, fault } = parseFault(body);
    if (vendor !== undefined && !fakes.vendors.includes(vendor)) throw new InputError(`${fakes.slug} has no ${vendor} fake`);
    const targets = (vendor === undefined ? fakes.vendors : [vendor]).flatMap((v) => fakesOf(fakes, v));
    const removers = targets.map((fake) => fake.inject(fault));
    const id = crypto.randomUUID();
    // A large removal changes the data rather than adding a fault; only a reset undoes it.
    if (fault.kind !== "large-removal") this.#faults.set(id, { id, vendor, fault, remove: () => removers.forEach((remove) => remove()) });
    return { id, vendor: vendor ?? "all", ...fault, ...(fault.kind === "large-removal" ? { note: "applied to the data; POST reset to undo" } : {}) };
  }

  #clearFaults(fakes: DistrictFakes) {
    for (const vendor of fakes.vendors) for (const fake of fakesOf(fakes, vendor)) fake.clearFaults();
    this.#faults.clear();
    return { cleared: true };
  }

  #removeFault(id: string): Response {
    const found = this.#faults.get(id);
    if (found === undefined) return notFound();
    found.remove();
    this.#faults.delete(id);
    return json({ removed: id });
  }

  #classroomToken(fakes: DistrictFakes, body: Record<string, unknown>): Response {
    if (fakes.classroom === undefined) return notFound();
    const { personId, scopes } = parseClassroomToken(body, Object.values(CLASSROOM_SCOPES));
    const token = fakes.classroom.issueToken({ userId: personId, scopes });
    return json({ access_token: token, token_type: "Bearer", expires_in: 3599, scope: scopes.join(" ") }, 201);
  }

  async #lti(fakes: DistrictFakes, flavour: LtiFlavourName, what: string, method: string, request: Request): Promise<Response> {
    const platform = fakes.lti[flavour];
    if (platform === undefined) return notFound();
    if (what === "tools" && method === "GET") return json({ tools: [...platform.tools.values()].map(storedTool) });
    if (what === "tools" && method === "POST") {
      const tool = platform.registerTool(parseTool(await jsonBody(request)));
      await this.#storeTools(flavour, fakes);
      return json(storedTool(tool), 201);
    }
    if (what === "tools" && method === "DELETE") {
      await this.ctx.storage.delete(`lti:${flavour}:tools`);
      this.#faults.clear();
      this.#fakes = undefined;
      return json({ cleared: true, note: "every fake of the district was rebuilt from its seed" });
    }
    if (what === "registrations" && method === "POST") {
      const started = platform.registrationInitiation(parseRegistration(await jsonBody(request)));
      return json(started, 201);
    }
    if (what === "launches" && method === "POST") {
      const login = platform.initiateLogin(parseLaunch(await jsonBody(request)));
      return json(login, 201);
    }
    return notFound();
  }
}
