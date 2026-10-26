// The Workers shell of the control plane: the Durable Object class and the site Worker's fetch
// handler. `sites/educateos-io/worker.ts` re-exports both, giving them the site's shell.
//
// The site Worker owns this Durable Object's data from its first deploy on, so it must keep its
// Worker name (`educateos-site`) and this class name: a renamed Worker or class starts with an
// empty namespace (SCHO-231). `sites/educateos-io/site-config.test.mjs` fails if either changes.
import { DurableObject } from "cloudflare:workers";
import type { JWTVerifyGetKey } from "jose";
import { operatorVerifier, type OperatorIdentity, type OperatorVerifier } from "./access.ts";
import { handleRequest, type ControlPlaneApi, type ControlPlaneDeps } from "./app.ts";
import { configuredLaunchDistricts } from "./clever-launch.ts";
import type { SiteShell } from "./pages.ts";
import type { ProbeResult } from "./probe.ts";
import { ControlPlaneRegistry, type DashboardEntry, type RegistryMessage, type RegistryReply } from "./registry.ts";
import { ControlPlaneStore, type Installation, type Operator, type Reservation } from "./store.ts";

/** The site Worker's bindings and vars. */
export interface ControlPlaneEnv {
  ASSETS: Fetcher;
  CONTROL_PLANE: DurableObjectNamespace<ControlPlane>;
  /** The Access team domain, `https://<team>.cloudflareaccess.com`. */
  ACCESS_ISSUER: string;
  /** The audience tag of the control plane's Access application. */
  ACCESS_AUD: string;
  /**
   * The educateos.io Clever app's OAuth client (secrets), for portal launches at /clever/launch
   * (SCHO-249). Without both, every launch is refused with a page.
   */
  CLEVER_CLIENT_ID?: string;
  CLEVER_CLIENT_SECRET?: string;
  /**
   * JSON object from Clever district ID to `<slug>.educateos.io`, for the project's own districts
   * that aren't registered installations (the demo districts). A var, not a secret.
   */
  CLEVER_LAUNCH_DISTRICTS?: string;
  /** Stamped by the ForgeGraph build (`scripts/production/stamp-commit.ts`). */
  FG_COMMIT_HASH?: string;
  /** Signed releases for the guided install, as `scripts/release/upload-release.ts` lays them out. */
  RELEASES?: R2Bucket;
  /** The release keys the guided install verifies releases against: a `ReleaseTrust`. */
  RELEASE_TRUST?: unknown;
}

/** The one Durable Object instance holding the control plane's state. */
export const CONTROL_PLANE_OBJECT = "educateos.io";

/** The control plane's store, as a Durable Object. Its methods are the store's, over RPC. */
export class ControlPlane extends DurableObject<ControlPlaneEnv> implements ControlPlaneApi {
  readonly #store: ControlPlaneStore;
  readonly #registry: ControlPlaneRegistry;

  constructor(ctx: DurableObjectState, env: ControlPlaneEnv) {
    super(ctx, env);
    this.#store = new ControlPlaneStore(ctx.storage);
    this.#registry = new ControlPlaneRegistry(ctx.storage, this.#store);
  }

  signIn(identity: OperatorIdentity): Operator {
    return this.#store.signIn(identity);
  }

  installations(operatorSubject: string): Installation[] {
    return this.#store.installations(operatorSubject);
  }

  recordInstallation(operatorSubject: string, installation: Installation): boolean {
    return this.#store.recordInstallation(operatorSubject, installation);
  }

  reserveInstall(operatorSubject: string, slug: string, accountId: string, proposed: string): Reservation {
    return this.#store.reserveInstall(operatorSubject, slug, accountId, proposed);
  }

  endInstall(operatorSubject: string, slug: string, release: boolean): void {
    this.#store.endInstall(operatorSubject, slug, release);
  }

  dashboard(operator: Operator): Promise<DashboardEntry[]> {
    return this.#registry.dashboard(operator);
  }

  receiveRegistryMessage(kind: RegistryMessage, input: unknown): Promise<RegistryReply> {
    return this.#registry.receive(kind, input);
  }

  /** Records the Clever district a registered installation serves. Never reachable over HTTP. */
  linkCleverDistrict(instanceId: string, cleverDistrictId: string): Promise<RegistryReply> {
    return this.#registry.linkCleverDistrict(instanceId, cleverDistrictId);
  }

  cleverLaunchHostname(cleverDistrictId: string): Promise<string | undefined> {
    return this.#registry.cleverLaunchHostname(cleverDistrictId);
  }

  ping(): true {
    return this.#store.ping();
  }
}

/** What {@link siteWorker} may be given besides the shell. */
export interface SiteWorkerOptions {
  /** The Access signing keys. Defaults to the team's published certs; tests pass a local key set. */
  accessKeys?: JWTVerifyGetKey;
  /** The dashboard's installation probe. Defaults to a real `/healthz` request; tests stub it. */
  probe?: (hostname: string) => Promise<ProbeResult>;
  /** Reaches Clever for portal launches. Defaults to the global `fetch`; tests stand in a fake Clever. */
  cleverFetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** The Cloudflare API the guided install drives. Defaults to api.cloudflare.com; tests use a fake. */
  cloudflareApi?: ControlPlaneDeps["cloudflareApi"];
}

/** The site Worker's fetch handler, with the site's shell. */
export function siteWorker(shell: SiteShell, options: SiteWorkerOptions = {}): ExportedHandler<ControlPlaneEnv> {
  let verifier: { key: string; verify: OperatorVerifier } | undefined;
  // Built on first use rather than per request, and inside the request's error handling, so a
  // misconfigured issuer fails the console with a page rather than every route, /healthz included.
  const verifierFor = (env: ControlPlaneEnv): OperatorVerifier => {
    const key = `${env.ACCESS_ISSUER} ${env.ACCESS_AUD}`;
    if (verifier?.key !== key) {
      verifier = { key, verify: operatorVerifier({ issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUD, keys: options.accessKeys }) };
    }
    return verifier.verify;
  };
  return {
    async fetch(request, env, ctx) {
      return handleRequest(request, {
        shell,
        verifyOperator: (operatorRequest) => verifierFor(env)(operatorRequest),
        store: () => env.CONTROL_PLANE.getByName(CONTROL_PLANE_OBJECT),
        assets: (assetRequest) => env.ASSETS.fetch(assetRequest),
        commit: env.FG_COMMIT_HASH,
        probe: options.probe,
        ...(env.CLEVER_CLIENT_ID && env.CLEVER_CLIENT_SECRET
          ? { clever: { clientId: env.CLEVER_CLIENT_ID, clientSecret: env.CLEVER_CLIENT_SECRET } }
          : {}),
        ...(options.cleverFetch === undefined ? {} : { cleverFetch: options.cleverFetch }),
        cleverLaunchDistricts: configuredLaunchDistricts(env.CLEVER_LAUNCH_DISTRICTS),
        ...(env.RELEASES && env.RELEASE_TRUST ? { releases: { bucket: env.RELEASES, trust: env.RELEASE_TRUST } } : {}),
        waitUntil: (promise) => ctx.waitUntil(promise),
        ...(options.cloudflareApi ? { cloudflareApi: options.cloudflareApi } : {}),
      });
    },
  };
}
