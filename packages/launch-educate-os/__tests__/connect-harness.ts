// The world `connect` and `status` run in: an installed Northfield district (the installer's
// Cloudflare fake), a stand-in for the district Worker's HTTP surface, and the provider fakes
// (Clever, Google's token endpoint and Classroom), all behind one `fetch` routed by origin.
//
// The district stand-in answers the routes `connect` calls with the shapes the district Worker
// answers (docs/educateos/lti.md, packages/educateos-district-app/src/routes.ts). It is a contract
// stub, not the Worker: the Worker's own behaviour is tested in its package.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  CleverDataFake,
  GoogleClassroomFake,
  GoogleServiceAccountTokenFake,
  SAMPLE_DISTRICT,
  syntheticServiceAccount,
} from "@educateos/provider-fakes";
import { main } from "../src/cli.ts";
import { TEST_CLOUDFLARE_RPC_ENV } from "../src/cloudflare.ts";
import {
  accountFor,
  type CloudflareBridge,
  deriveRelease,
  goldenRelease,
  NORTHFIELD,
  northfieldAnswers,
  type ReleaseServer,
  serveCloudflare,
  serveReleases,
  writeAnswersFile,
  writeTrustFile,
} from "./harness.ts";

/** The district's public origin in the fixture. */
export const ORIGIN = "https://educateos.northfield.example";
/** The district Worker's name in the fixture. */
export const DISTRICT_WORKER = "educateos-northfield-educateos-district-worker";
/** The Access token a district administrator pastes, which the stand-in accepts. */
export const ADMIN_ACCESS_TOKEN = "synthetic-access-token-for-a-district-admin";

/** A pending registration, as the district stores one. */
interface Pending {
  id: string;
  issuer: string;
  clientId: string;
  deploymentId?: string;
  productFamily?: string;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The district Worker's HTTP surface, as `connect` sees it. */
export class FakeDistrict {
  invitations = 0;
  /** What the LMS registers the next time an invitation is used (set by a test). */
  onInvitation: Pending | undefined;
  readonly pending: Pending[] = [];
  readonly registrations: { provider: string; issuer: string; clientId: string; deploymentIds: string[]; offerings: { contextId: string; offeringId: string }[] }[] = [];
  readonly trusted: string[] = [];
  readonly rosterApplies: Record<string, string>[] = [];
  rosterProvider = "none";
  rosterReason: string | undefined = "no configuration revision has been applied";
  /** Whether Access fronts `/lti/*` (the bypass missing). */
  ltiBehindAccess = false;
  /** Headers of every admin call, to check the token goes nowhere else. */
  readonly adminCalls: { method: string; path: string; body: unknown }[] = [];

  /** Simulates the LMS completing Dynamic Registration with the last invitation. */
  register(entry: Pending): void {
    this.pending.push(entry);
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const toAccess = () => new Response(null, { status: 302, headers: { location: `https://northfield.cloudflareaccess.com/cdn-cgi/access/login/${url.host}` } });
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/lti/jwks") return this.ltiBehindAccess ? toAccess() : json({ keys: [{ kty: "RSA", kid: "k1", n: "x", e: "AQAB" }] });
    if (!url.pathname.startsWith("/api/")) return toAccess();
    if (request.headers.get("cf-access-token") !== ADMIN_ACCESS_TOKEN) return toAccess();
    const body = request.method === "POST" ? JSON.parse(await request.text() || "{}") as Record<string, unknown> : undefined;
    if (request.method === "POST" && request.headers.get("content-type") !== "application/json") return json({ code: "validation-failed", message: "expected JSON" }, 400);
    this.adminCalls.push({ method: request.method, path: url.pathname, body });
    const route = `${request.method} ${url.pathname}`;
    if (route === "POST /api/lti/invitations") {
      this.invitations++;
      if (this.onInvitation) this.register(this.onInvitation);
      return json({ url: `${ORIGIN}/lti/register?invitation=synthetic-invitation-${this.invitations}`, expiresAt: "2026-11-14T18:00:00.000Z" });
    }
    if (route === "GET /api/lti/registrations") return json({ registrations: this.registrations, pending: this.pending });
    if (route === "POST /api/lti/trusted-issuers") {
      const issuer = String(body!.issuer);
      if (!this.pending.some((p) => p.issuer === issuer)) return json({ code: "not-found", message: "No registration names that issuer." }, 404);
      this.trusted.push(issuer);
      return json({ trustedIssuers: this.trusted });
    }
    const approve = /^POST \/api\/lti\/pending\/([^/]+)\/approve$/.exec(route);
    if (approve) {
      const index = this.pending.findIndex((p) => p.id === approve[1]);
      if (index === -1) return json({ code: "not-found", message: "No such pending registration." }, 404);
      const entry = this.pending[index]!;
      if (!this.trusted.includes(entry.issuer)) return json({ code: "conflict", message: "Trust the issuer first." }, 409);
      const deploymentIds = (body!.deploymentIds as string[] | undefined) ?? (entry.deploymentId ? [entry.deploymentId] : []);
      if (deploymentIds.length === 0) return json({ code: "validation-failed", message: "A deployment ID is required." }, 400);
      this.pending.splice(index, 1);
      const saved = { provider: String(body!.provider), issuer: entry.issuer, clientId: entry.clientId, deploymentIds, offerings: body!.offerings as { contextId: string; offeringId: string }[] };
      this.registrations.push(saved);
      return json(saved);
    }
    if (route === "GET /api/admin/roster/sync") {
      return json({ provider: this.rosterProvider, runnable: this.rosterReason === undefined, ...(this.rosterReason ? { reason: this.rosterReason } : {}), runs: [] });
    }
    if (route === "POST /api/admin/roster/preview" || route === "POST /api/admin/roster/apply") {
      const files = body!.files as Record<string, string>;
      const users = (files["users.csv"] ?? "").trim().split("\n").length - 1;
      const preview = {
        canApply: users > 0, issues: users > 0 ? [] : [{ severity: "error", message: "no users" }], integrity: [], quarantined: [], linked: [],
        changes: { principals: { created: Array.from({ length: Math.max(users, 0) }, (_, i) => `p${i}`), updated: [] }, offerings: { created: ["o1"] } },
      };
      if (route.endsWith("/apply")) {
        this.rosterApplies.push(files);
        return json({ applied: preview.canApply, preview, grantsRevoked: 0 });
      }
      return json(preview);
    }
    return json({ code: "not-found", message: `no route ${route}` }, 404);
  };
}

/** Everything a connect test needs. */
export interface ConnectWorld {
  mirror: ReleaseServer;
  cloudflare: CloudflareBridge;
  trust: string;
  district: FakeDistrict;
  clever: CleverDataFake;
  classroom: GoogleClassroomFake;
  google: GoogleServiceAccountTokenFake;
  /** The directory holding the installed district's answers file. */
  dir: string;
  answersPath: string;
  /** The fetch the CLI runs with: the fakes by origin, anything else (the release mirror) for real. */
  fetch: typeof fetch;
  env: Record<string, string>;
  close(): Promise<void>;
}

/** Installs a one-origin Northfield district into the Cloudflare fake, and stands up the fakes around it. */
export async function connectWorld(): Promise<ConnectWorld> {
  const release = await deriveRelease(await goldenRelease(), "r000001-aaaaaaa");
  const mirror = await serveReleases(release);
  const cloudflare = await serveCloudflare(accountFor(NORTHFIELD));
  const trust = writeTrustFile();
  const { dir, path } = writeAnswersFile(northfieldAnswers({
    gatekeepers: [],
    services: { "educateos-district-worker": { enabled: true, vars: { DISTRICT_CONFIG: JSON.stringify({ synthetic: "northfield district config" }) } } },
  }));
  const env = { [TEST_CLOUDFLARE_RPC_ENV]: cloudflare.url, CLOUDFLARE_API_TOKEN: cloudflare.token };
  const installed = await run(["install", "--config", path, "--yes", "--release-url", mirror.base, "--trust", trust], { cwd: dir, env });
  if (installed.code !== 0) throw new Error(`the fixture install failed: ${installed.stderr}`);

  const district = new FakeDistrict();
  const clever = new CleverDataFake({ seed: SAMPLE_DISTRICT });
  const classroom = new GoogleClassroomFake({ seed: SAMPLE_DISTRICT });
  const google = new GoogleServiceAccountTokenFake({ classroom, people: SAMPLE_DISTRICT.people });
  const routes: Record<string, (request: Request) => Promise<Response>> = {
    [ORIGIN]: district.fetch,
    "https://api.clever.com": (request) => clever.fetch(request),
    "https://oauth2.googleapis.com": (request) => google.fetch(request),
    "https://classroom.googleapis.com": (request) => classroom.fetch(request),
  };
  const routed = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const handle = routes[new URL(request.url).origin];
    return handle ? await handle(request) : await fetch(request);
  }) as typeof fetch;
  return {
    mirror, cloudflare, trust, district, clever, classroom, google, dir, answersPath: path, fetch: routed, env,
    close: async () => {
      await mirror.close();
      await cloudflare.close();
    },
  };
}

/** A Workspace administrator in the provider fakes' sample district. */
export const WORKSPACE_ADMIN = SAMPLE_DISTRICT.people.find((p) => p.id === "mw-t-okafor")!.email;

/** Writes a synthetic service account key file, delegated (or not) in the world's Google fake. */
export async function serviceAccountKeyFile(world: ConnectWorld, scopes: readonly string[] | undefined): Promise<string> {
  const account = await syntheticServiceAccount("roster@northfield-synthetic.iam.gserviceaccount.com");
  if (scopes) world.google.delegate({ clientEmail: account.keyFile.client_email, publicKeyPem: account.publicKeyPem, scopes });
  const path = join(world.dir, "service-account.json");
  writeFileSync(path, JSON.stringify(account.keyFile));
  return path;
}

/** One CLI run: in process, with `answers` typed on a terminal when given, else without one. */
export async function run(
  argv: string[],
  options: { cwd: string; env: Record<string, string>; fetch?: typeof fetch; answers?: string[] },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdin = Object.assign(new PassThrough(), options.answers ? { isTTY: true } : {});
  stdin.end((options.answers ?? []).map((answer) => `${answer}\n`).join(""));
  let stdout = "";
  let stderr = "";
  const code = await main({
    argv,
    env: options.env,
    cwd: options.cwd,
    stdin,
    stdout: { ...(options.answers ? { isTTY: true } : {}), write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return { code, stdout, stderr };
}
