// The admin Worker (SCHO-263): admin.educateos.io in the hosted edition, admin.<district domain> in
// the open-source one. Its D1 binding is DB; the SPA is the ASSETS binding.
//
// wrangler.local.jsonc runs it locally. wrangler.production.jsonc is the hosted edition at
// admin.educateos.io (docs/educateos/runbooks/admin-hosted.md); the installer adding the OSS admin to
// a district's account comes in a later phase 5 PR.
import { operatorVerifier, type OperatorVerifier } from "@educateos/control-plane/access";
import type { JWTVerifyGetKey } from "jose";
import { handleAdminRequest } from "./app.ts";
import { parseAdmins, readConfig } from "./config.ts";
import type { FetchLike } from "./district.ts";
import type { ControlPlaneSource } from "./import.ts";
import { importKeyEncryptionKey } from "./keys.ts";
import { AdminStore } from "./store.ts";

/** The admin Worker's bindings, vars and secrets. */
export interface AdminEnv {
  DB: D1Database;
  /** The built SPA. */
  ASSETS?: Fetcher;
  /** The Access team domain, `https://<team>.cloudflareaccess.com`. */
  ACCESS_ISSUER: string;
  /** The audience tag of this admin's Access application. */
  ACCESS_AUD: string;
  /** Who may sign in (see config.ts). */
  ADMINS?: string;
  /** hosted | oss. */
  EDITION?: string;
  /** oss: the origins this admin may manage. */
  OSS_WORKSPACE_ORIGINS?: string;
  /** Secret: 32 random bytes, base64url, sealing the ops private keys in D1. */
  ADMIN_KEY_ENCRYPTION_KEY?: string;
  /** Stamped by the ForgeGraph build. */
  FG_COMMIT_HASH?: string;
  /**
   * Hosted edition: a service binding to the educateos-site Worker's `ControlPlaneExporter`
   * entrypoint, the read-only export the import reads (SCHO-263). Unbound, the import is unavailable.
   */
  CONTROL_PLANE?: ControlPlaneSource;
}

/** What {@link adminWorker} may be given. Tests pass a local Access key set and a fake district. */
export interface AdminWorkerOptions {
  accessKeys?: JWTVerifyGetKey;
  fetchDistrict?: FetchLike;
  now?: () => Date;
  /** Stands in for the CONTROL_PLANE binding. */
  controlPlane?: ControlPlaneSource;
}

/** The admin's fetch handler. */
export function adminWorker(options: AdminWorkerOptions = {}): ExportedHandler<AdminEnv> {
  let verifier: { key: string; verify: OperatorVerifier } | undefined;
  let kek: { secret: string | undefined; key: Promise<CryptoKey> } | undefined;
  const verifierFor = (env: AdminEnv): OperatorVerifier => {
    const key = `${env.ACCESS_ISSUER} ${env.ACCESS_AUD}`;
    if (verifier?.key !== key) {
      verifier = { key, verify: operatorVerifier({ issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUD, ...(options.accessKeys ? { keys: options.accessKeys } : {}) }) };
    }
    return verifier.verify;
  };
  // workerd needs fetch bound to the global scope when it is stored and called later.
  const fetchDistrict: FetchLike = options.fetchDistrict ?? ((request) => fetch(request));
  return {
    async fetch(request, env) {
      const controlPlane = options.controlPlane ?? env.CONTROL_PLANE;
      return handleAdminRequest(request, {
        store: new AdminStore(env.DB),
        config: () => readConfig(env),
        admins: parseAdmins(env.ADMINS),
        // Built lazily, inside the request's error handling, so a bad issuer fails /api, not /healthz.
        verifyOperator: (operatorRequest) => verifierFor(env)(operatorRequest),
        keyEncryptionKey: () => {
          if (kek === undefined || kek.secret !== env.ADMIN_KEY_ENCRYPTION_KEY) {
            const key = importKeyEncryptionKey(env.ADMIN_KEY_ENCRYPTION_KEY);
            // A rejected import isn't cached, so fixing the secret takes effect without a restart.
            key.catch(() => { kek = undefined; });
            kek = { secret: env.ADMIN_KEY_ENCRYPTION_KEY, key };
            return key;
          }
          return kek.key;
        },
        fetchDistrict,
        ...(env.ASSETS ? { assets: (assetRequest: Request) => env.ASSETS!.fetch(assetRequest) } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(env.FG_COMMIT_HASH ? { commit: env.FG_COMMIT_HASH } : {}),
        ...(controlPlane === undefined ? {} : { controlPlane }),
      });
    },
  };
}

export default adminWorker();
