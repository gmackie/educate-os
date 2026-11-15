// Boots the synthetic Pilot Lakes district in memory for the student-led learning pilot (SCHO-432).
// It serves the real district application over its real typed routes; only the IdP is a stand-in.
// No network, no model, no production store.
import type { DistrictDirectorySnapshot, EducateOsErrorBody } from "@educateos/contracts";
import { catalogSeedRelease } from "@educateos/catalog";
import {
  createDistrictApp,
  inMemoryDistrictStores,
  InMemoryPolicyAuditLog,
  ROUTES,
  routePath,
  successStatus,
  type DistrictApp,
  type DistrictAppOptions,
  type RouteInput,
  type RouteName,
  type RouteResponse,
} from "@educateos/district-app";
import { PILOT_LEARNING, PL } from "@educateos/fixtures";
import type { VerifiedIdentity } from "@educateos/contracts";

/** A planner plan as the student route returns it (the district app does not export the schema's type). */
export type PilotPlan = RouteResponse<"student.planGoal">;

/** What a call returned: the status and the parsed body, unmodified. */
export interface PilotCall {
  status: number;
  body: unknown;
}

/** A booted pilot district: the application, a settable clock and a typed caller. */
export interface PilotDistrict {
  app: DistrictApp;
  directory: DistrictDirectorySnapshot;
  audit: InMemoryPolicyAuditLog;
  stores: ReturnType<typeof inMemoryDistrictStores>;
  /** Moves the district clock. Server-observed times, such as help and share times, follow it. */
  setNow(iso: string): void;
  now(): Date;
  /** A bearer token for a synthetic principal. */
  tokenFor(principalId: string): string;
  /** A token for an IdP subject that has no principal here, such as a guardian awaiting onboarding. */
  issue(subject: string): string;
  /** Calls a route and returns whatever came back. */
  call<N extends RouteName>(token: string | undefined, name: N, input?: RouteInput<N>): Promise<PilotCall>;
  /** Calls a route and returns its schema-checked body, throwing on any error status. */
  ok<N extends RouteName>(token: string, name: N, input?: RouteInput<N>): Promise<RouteResponse<N>>;
}

/** The options a pilot run may inject. `plannerAi` is for adversarial tests only; it is absent by default. */
export type PilotOptions = Partial<Pick<DistrictAppOptions, "plannerAi" | "aiHelp" | "fundingPools" | "modelCatalog">> & {
  /** The district's starting clock. Defaults to a fixed instant so every run replays identically. */
  startsAt?: string;
  /** The approved catalog seeds. Defaults to Common Core ELA and math; `[]` approves none. */
  standards?: readonly string[];
  directory?: DistrictDirectorySnapshot;
};

/** The fixed instant replays start at, so goldens never depend on the wall clock. */
export const PILOT_EPOCH = "2026-11-16T15:00:00.000Z";

/** Boots the synthetic district. Same input, same transcript. */
export async function bootPilotDistrict(options: PilotOptions = {}): Promise<PilotDistrict> {
  const directory = options.directory ?? PILOT_LEARNING;
  const issuer = directory.district.trustedIssuers[0]!;
  const tokens = new Map<string, string>();
  let clock = new Date(options.startsAt ?? PILOT_EPOCH);
  const verifyRequest = async (request: Request): Promise<VerifiedIdentity | undefined> => {
    const header = request.headers.get("authorization") ?? "";
    const subject = header.startsWith("Bearer ") ? tokens.get(header.slice("Bearer ".length)) : undefined;
    return subject === undefined ? undefined : { issuer, subject, credential: "person" };
  };
  const stores = inMemoryDistrictStores(directory);
  const audit = new InMemoryPolicyAuditLog();
  const app = await createDistrictApp({
    stores: { ...stores, audit },
    verifyRequest,
    // The pilot imports nothing from the web: every URL is a 404.
    importFetch: async () => new Response("not found", { status: 404 }),
    now: () => clock,
    // Synthetic personas only: nothing here is a real child's post.
    unscreenedStudentPosts: "publish",
    ...(options.plannerAi === undefined ? {} : { plannerAi: options.plannerAi }),
    ...(options.aiHelp === undefined ? {} : { aiHelp: options.aiHelp }),
    ...(options.fundingPools === undefined ? {} : { fundingPools: options.fundingPools }),
    ...(options.modelCatalog === undefined ? {} : { modelCatalog: options.modelCatalog }),
  });
  const admin = directory.roleAssignments.find((r) => r.role === "district-admin")!.principalId;
  const actor = { by: admin, at: clock.toISOString() };
  for (const key of options.standards ?? ["ccss-ela", "ccss-math"]) {
    const release = await catalogSeedRelease(key);
    await app.catalog.select(key, actor);
    await app.catalog.install(release, actor);
    await app.catalog.approve(key, release.version, actor);
  }

  const issue = (subject: string) => {
    const token = crypto.randomUUID();
    tokens.set(token, subject);
    return token;
  };
  const tokenFor = (principalId: string) => {
    const principal = directory.principals.find((p) => p.id === principalId);
    if (principal === undefined) throw new Error(`no synthetic principal ${principalId}`);
    return issue(principal.externalIdentities[0]!.subject);
  };
  const call = async <N extends RouteName>(token: string | undefined, name: N, input: RouteInput<N> = {} as RouteInput<N>): Promise<PilotCall> => {
    const spec = ROUTES[name];
    const parts = input as { params?: Record<string, string>; query?: Record<string, string>; body?: unknown };
    const url = new URL(routePath(spec.path, parts.params), "https://district.pilot.example");
    for (const [key, value] of Object.entries(parts.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const response = await app.fetch(new Request(url, { method: spec.method, headers, ...(spec.method === "POST" ? { body: JSON.stringify(parts.body ?? {}) } : {}) }));
    const body: unknown = await response.json();
    if (response.ok) {
      if (response.status !== successStatus(spec)) throw new Error(`${name} answered ${response.status}, expected ${successStatus(spec)}`);
      spec.response.parse(body);
    }
    return { status: response.status, body };
  };
  const ok = async <N extends RouteName>(token: string, name: N, input?: RouteInput<N>): Promise<RouteResponse<N>> => {
    const result = await call(token, name, input);
    if (result.status >= 400) throw new Error(`${name} failed with ${result.status}: ${JSON.stringify(result.body)}`);
    return ROUTES[name].response.parse(result.body) as RouteResponse<N>;
  };

  return { app, directory, audit, stores, setNow: (iso) => { clock = new Date(iso); }, now: () => clock, tokenFor, issue, call, ok };
}

/** The error code of a failed call, or `ok` for a success. */
export const outcomeOf = (result: PilotCall): string => (result.status < 400 ? "ok" : `${result.status} ${(result.body as EducateOsErrorBody).code}`);

export { PL };
