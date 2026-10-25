import {
  checkDirectoryIntegrity,
  DistrictDirectorySnapshot,
  EducateOsError,
  type ErrorCode,
  type Principal,
} from "@educateos/contracts";
import { createDirectoryPrincipalResolver, type PrincipalResolver } from "@educateos/identity";
import type { FakeAiProvider } from "./fake-ai.ts";
import type { FakeIdentityProvider } from "./fake-identity.ts";
import { identityFromBearer } from "./sign-in.ts";

/** A roster source. The fake returns a fixture; A03 and A04 will add OneRoster CSV and REST. */
export interface RosterProvider {
  /** Which provider this is, reported in health. */
  readonly kind: string;
  /** The current directory snapshot. Unvalidated: the district parses and checks it. */
  fetchSnapshot(): Promise<unknown>;
}

/** A roster provider that serves a fixed snapshot, deep-copied on every fetch. */
export class FakeRosterProvider implements RosterProvider {
  /** Reported in health. */
  readonly kind = "fake";
  readonly #snapshot: DistrictDirectorySnapshot;

  constructor(snapshot: DistrictDirectorySnapshot) {
    this.#snapshot = snapshot;
  }

  /** A fresh copy, so no two districts (or two syncs) ever share mutable state. */
  async fetchSnapshot(): Promise<unknown> {
    return structuredClone(this.#snapshot);
  }
}

/** The providers one district runs with. */
export interface DistrictProviders {
  /** Roster source for the directory. */
  roster: RosterProvider;
  /** The district's IdP. Only its tokens are accepted. */
  identity: FakeIdentityProvider;
  /** The district's model provider. */
  ai: FakeAiProvider;
}

/** The health report served at `GET /health`. It has counts and states, never names or content. */
export interface DistrictHealth {
  /** The district. */
  districtId: string;
  /** `ok` once the directory loaded and passed its integrity checks. */
  status: "ok";
  /** Seeded directory sizes. */
  directory: {
    schools: number;
    terms: number;
    offerings: number;
    principals: number;
    students: number;
    staff: number;
    activeEnrollments: number;
  };
  /** Which provider backs each port. */
  providers: { identity: string; roster: string; ai: string };
  /** AI usage across the district, as counts. */
  aiUsage: { requests: number; tokens: number };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const HTTP_STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  "validation-failed": 400,
  "policy-violation": 403,
  "budget-exceeded": 402,
  unavailable: 503,
};

const errorResponse = (error: EducateOsError) => json(error.toBody(), HTTP_STATUS[error.code]);

/**
 * One isolated synthetic district. It owns its directory and providers outright; nothing is shared
 * with any other instance, so isolation does not depend on any check being remembered.
 *
 * Its HTTP surface is deliberately small and grows with later PRs:
 * - `GET /health`
 * - `GET /me`: the bearer token's principal, with roles from the directory only
 * - `POST /ai/complete`: a fake completion, attributed to the bearer's principal
 */
export class DistrictInstance {
  /** The loaded directory. */
  readonly directory: DistrictDirectorySnapshot;
  readonly #providers: DistrictProviders;
  readonly #resolver: PrincipalResolver;

  private constructor(directory: DistrictDirectorySnapshot, providers: DistrictProviders) {
    this.directory = directory;
    this.#providers = providers;
    this.#resolver = createDirectoryPrincipalResolver(directory);
  }

  /**
   * Loads the directory from the roster provider and refuses to start if it fails to parse or
   * fails any integrity check, or if the IdP's issuer is not one the district trusts.
   */
  static async boot(providers: DistrictProviders): Promise<DistrictInstance> {
    const directory = DistrictDirectorySnapshot.parse(await providers.roster.fetchSnapshot());
    const issues = checkDirectoryIntegrity(directory);
    if (issues.length > 0) {
      throw new Error(`refusing to boot ${directory.district.id}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    }
    if (!directory.district.trustedIssuers.includes(providers.identity.issuer)) {
      throw new Error(`refusing to boot ${directory.district.id}: its IdP ${providers.identity.issuer} is not a trusted issuer`);
    }
    return new DistrictInstance(directory, providers);
  }

  /** The district's ID. */
  get districtId(): string {
    return this.directory.district.id;
  }

  /** The health report. */
  health(): DistrictHealth {
    const { directory } = this;
    return {
      districtId: directory.district.id,
      status: "ok",
      directory: {
        schools: directory.schools.length,
        terms: directory.terms.length,
        offerings: directory.offerings.length,
        principals: directory.principals.length,
        students: directory.principals.filter((p) => p.kind === "student").length,
        staff: directory.principals.filter((p) => p.kind === "staff").length,
        activeEnrollments: directory.enrollments.filter((e) => e.status === "active").length,
      },
      providers: { identity: "fake", roster: this.#providers.roster.kind, ai: "fake" },
      aiUsage: this.#providers.ai.totals(),
    };
  }

  /**
   * Resolves a bearer token to a principal, through `identityFromAccessPayload` and the
   * directory's `createDirectoryPrincipalResolver` (see `sign-in.ts`). The token proves only
   * `(issuer, subject)`; the principal and everything about it come from this district's directory.
   */
  async resolvePrincipal(request: Request): Promise<Principal> {
    const identity = await identityFromBearer(request, this.#providers.identity);
    if (identity === undefined) throw new EducateOsError("unauthenticated", "Sign in with this district's identity provider.");
    const { principalId } = await this.#resolver.resolve(identity);
    return this.directory.principals.find((p) => p.id === principalId)!;
  }

  /** Handles one HTTP request. */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (request.method === "GET" && pathname === "/health") return json(this.health());
      if (request.method === "GET" && pathname === "/me") {
        const principal = await this.resolvePrincipal(request);
        return json({
          principalId: principal.id,
          districtId: principal.districtId,
          kind: principal.kind,
          displayName: principal.displayName,
          roles: this.directory.roleAssignments
            .filter((r) => r.principalId === principal.id)
            .map(({ role, scope }) => ({ role, scope })),
          enrollments: this.directory.enrollments
            .filter((e) => e.principalId === principal.id && e.status === "active")
            .map(({ offeringId, role }) => ({ offeringId, role })),
        });
      }
      if (request.method === "POST" && pathname === "/ai/complete") {
        const principal = await this.resolvePrincipal(request);
        const body: unknown = await request.json().catch(() => null);
        const prompt = (body as { prompt?: unknown } | null)?.prompt;
        if (typeof prompt !== "string") throw new EducateOsError("validation-failed", "Expected a JSON body with a string prompt.");
        return json(this.#providers.ai.complete(principal.id, prompt));
      }
      throw new EducateOsError("not-found", "No such route.");
    } catch (error) {
      if (error instanceof EducateOsError) return errorResponse(error);
      throw error;
    }
  }
}
