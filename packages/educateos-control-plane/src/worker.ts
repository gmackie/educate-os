// The Workers shell of the control plane: the Durable Object class and the site Worker's fetch
// handler. `sites/educateos-io/worker.ts` re-exports both, giving them the site's shell.
//
// The site Worker owns this Durable Object's data from its first deploy on, so it must keep its
// Worker name (`educateos-site`) and this class name: a renamed Worker or class starts with an
// empty namespace (SCHO-231). `sites/educateos-io/site-config.test.mjs` fails if either changes.
import { DurableObject } from "cloudflare:workers";
import type { JWTVerifyGetKey } from "jose";
import { operatorVerifier, type OperatorIdentity, type OperatorVerifier } from "./access.ts";
import { handleRequest, type ControlPlaneApi } from "./app.ts";
import type { SiteShell } from "./pages.ts";
import { ControlPlaneStore, type Installation, type Operator } from "./store.ts";

/** The site Worker's bindings and vars. */
export interface ControlPlaneEnv {
  ASSETS: Fetcher;
  CONTROL_PLANE: DurableObjectNamespace<ControlPlane>;
  /** The Access team domain, `https://<team>.cloudflareaccess.com`. */
  ACCESS_ISSUER: string;
  /** The audience tag of the control plane's Access application. */
  ACCESS_AUD: string;
  /** Stamped by the ForgeGraph build (`scripts/production/stamp-commit.ts`). */
  FG_COMMIT_HASH?: string;
}

/** The one Durable Object instance holding the control plane's state. */
export const CONTROL_PLANE_OBJECT = "educateos.io";

/** The control plane's store, as a Durable Object. Its methods are the store's, over RPC. */
export class ControlPlane extends DurableObject<ControlPlaneEnv> implements ControlPlaneApi {
  readonly #store: ControlPlaneStore;

  constructor(ctx: DurableObjectState, env: ControlPlaneEnv) {
    super(ctx, env);
    this.#store = new ControlPlaneStore(ctx.storage);
  }

  signIn(identity: OperatorIdentity): Operator {
    return this.#store.signIn(identity);
  }

  installations(operatorSubject: string): Installation[] {
    return this.#store.installations(operatorSubject);
  }

  ping(): true {
    return this.#store.ping();
  }
}

/** What {@link siteWorker} may be given besides the shell. */
export interface SiteWorkerOptions {
  /** The Access signing keys. Defaults to the team's published certs; tests pass a local key set. */
  accessKeys?: JWTVerifyGetKey;
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
    async fetch(request, env) {
      return handleRequest(request, {
        shell,
        verifyOperator: (operatorRequest) => verifierFor(env)(operatorRequest),
        store: () => env.CONTROL_PLANE.getByName(CONTROL_PLANE_OBJECT),
        assets: (assetRequest) => env.ASSETS.fetch(assetRequest),
        commit: env.FG_COMMIT_HASH,
      });
    },
  };
}
