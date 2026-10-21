// The probes behind `verify-account.ts` (SCHO-66): each one checks an item that
// `docs/schoolos/installer-permissions.md` marks unverified, against a SANDBOX Cloudflare account,
// through the installer's own `CloudflareHttpApi` wherever the installer has the operation, so the
// installer's request shapes and response parsing are what get verified.
//
// Read probes always run and change nothing. Create/delete probes run only with `apply`, name
// every resource `schoolos-probe-<runId>…`, register its deletion the moment it exists, and delete
// everything they made in reverse order even when a later probe fails. The report holds HTTP
// statuses, Cloudflare's numeric codes and booleans, never a token, a response body or free text
// from Cloudflare.
import { CloudflareApiError } from "../src/errors.ts";
import { CloudflareHttpApi, CLOUDFLARE_API_BASE, R2_NOT_ENABLED_CODE } from "../src/cloudflare-http.ts";
import { staticTokenProvider } from "../src/token.ts";

/** Every probe resource name starts with this, so leftovers are recognisable and sweepable. */
export const PROBE_PREFIX = "schoolos-probe-";

/** What a probe established. */
export type ProbeResult = "ok" | "denied" | "error" | "skipped" | "planned";

/** One line of the report. */
export interface ProbeRecord {
  /** Stable probe ID, e.g. `read.listR2Buckets`. */
  readonly id: string;
  /** The unverified claim in installer-permissions.md this probe checks. */
  readonly checks: string;
  /** `read` changes nothing; `create-delete` needs `--apply`. */
  readonly kind: "read" | "create-delete";
  readonly result: ProbeResult;
  readonly httpStatus?: number;
  readonly cloudflareCodes?: readonly number[];
  /** Facts the probe observed: booleans, counts, rate plan IDs. Never secrets or response bodies. */
  readonly observation?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  /** Why the probe was skipped. */
  readonly reason?: string;
}

/** The deletion of one probe resource. */
export interface CleanupRecord {
  readonly resource: string;
  readonly deleted: boolean;
  readonly httpStatus?: number;
  readonly cloudflareCodes?: readonly number[];
}

/** The JSON report the harness writes. */
export interface VerificationReport {
  readonly schema: "schoolos.verify-account/v1";
  readonly runId: string;
  readonly startedAt: string;
  readonly accountId: string;
  readonly mode: "dry-run" | "apply";
  readonly zone?: string;
  readonly probes: readonly ProbeRecord[];
  readonly cleanup: readonly CleanupRecord[];
  /** Probe resources that could not be deleted. Delete them by hand (the runbook lists where). */
  readonly leftovers: readonly string[];
}

/** What a verification run needs. */
export interface VerificationOptions {
  readonly token: string;
  readonly accountId: string;
  /**
   * The sandbox account's exact name. The run stops before any other call unless the token's
   * account has this name, so a production token pasted by mistake changes nothing.
   */
  readonly expectedAccountName: string;
  /** A zone in the sandbox account. Without one, DNS, custom-domain and Access-app probes skip. */
  readonly zone?: string;
  readonly apply: boolean;
  /** 8 lowercase hex characters, unique per run. */
  readonly runId: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly baseUrl?: string;
}

/** Thrown when the account guard refuses to run. Nothing was changed. */
export class SandboxGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxGuardError";
  }
}

interface RawResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly codes: readonly number[];
  readonly result: unknown;
}

/** A deliberately invalid bearer, to observe the codes Cloudflare returns for a bad credential. */
const INVALID_TOKEN = "schoolos-probe-invalid-token";

/** A minimal module Worker for the upload probe. It serves nothing useful. */
const PROBE_WORKER_SOURCE = 'export default { fetch() { return new Response("schoolos probe"); } };\n';
const PROBE_VAR = "SCHOOLOS_PROBE_VAR";
const PROBE_VAR_VALUE = "schoolos-probe-plain-text";

/**
 * Runs every probe and returns the report. Throws {@link SandboxGuardError} before touching
 * anything else when the account is not the expected sandbox.
 */
export async function verifyAccount(options: VerificationOptions): Promise<VerificationReport> {
  if (!/^[0-9a-f]{8}$/.test(options.runId)) throw new SandboxGuardError("runId must be 8 lowercase hex characters.");
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl ?? CLOUDFLARE_API_BASE;
  const api = new CloudflareHttpApi({ tokens: staticTokenProvider("district-run", options.token), fetch: doFetch, baseUrl: base });
  const account = options.accountId;
  const name = `${PROBE_PREFIX}${options.runId}`;
  const probes: ProbeRecord[] = [];
  const cleanups: { resource: string; run: () => Promise<RawResponse> }[] = [];

  const raw = async (method: string, path: string, init: { json?: unknown; bearer?: string } = {}): Promise<RawResponse> => {
    const headers: Record<string, string> = { authorization: `Bearer ${init.bearer ?? options.token}` };
    if (init.json !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await doFetch(new URL(base + path), { method, headers, body: init.json === undefined ? undefined : JSON.stringify(init.json) });
    } catch {
      return { status: 0, ok: false, codes: [], result: undefined };
    }
    const body: unknown = await response.json().catch(() => undefined);
    const envelope = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const errors = Array.isArray(envelope["errors"]) ? envelope["errors"] : [];
    const codes = errors.flatMap((e) => (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "number" ? [(e as { code: number }).code] : []));
    return { status: response.status, ok: response.ok && envelope["success"] === true, codes, result: envelope["result"] };
  };

  /** Runs one installer operation and records it; returns its value, or undefined on failure. */
  const probe = async <T>(
    id: string,
    checks: string,
    kind: ProbeRecord["kind"],
    run: () => Promise<T>,
    observe?: (value: T) => ProbeRecord["observation"],
  ): Promise<T | undefined> => {
    try {
      const value = await run();
      const observation = observe?.(value);
      probes.push({ id, checks, kind, result: "ok", ...(observation ? { observation } : {}) });
      return value;
    } catch (error) {
      if (!(error instanceof CloudflareApiError)) throw error;
      const denied = error.code === "unauthenticated" || error.code === "forbidden";
      probes.push({
        id,
        checks,
        kind,
        result: denied ? "denied" : "error",
        httpStatus: error.status,
        cloudflareCodes: error.cloudflareCodes,
        ...(error.cloudflareCodes.includes(R2_NOT_ENABLED_CODE) ? { observation: { r2NotEnabledCode: true } } : {}),
      });
      return undefined;
    }
  };
  const skip = (id: string, checks: string, kind: ProbeRecord["kind"], reason: string, result: ProbeResult = "skipped"): void => {
    probes.push({ id, checks, kind, result, reason });
  };
  const onCleanup = (resource: string, run: () => Promise<RawResponse>) => cleanups.push({ resource, run });

  // The guard. Nothing else runs until the account is confirmed to be the named sandbox.
  const found = await api.getAccount(account).catch((error: unknown) => {
    if (error instanceof CloudflareApiError) throw new SandboxGuardError(`Cannot read account ${account} (${error.message}); nothing was changed.`);
    throw error;
  });
  if (found.name !== options.expectedAccountName) {
    throw new SandboxGuardError("The token's account is not the expected sandbox account; nothing was changed.");
  }
  probes.push({ id: "read.getAccount", checks: "Account Settings: Read / account:read covers getAccount", kind: "read", result: "ok" });

  // Read probes.
  const userVerify = await raw("GET", "/user/tokens/verify");
  const accountVerify = await raw("GET", `/accounts/${seg(account)}/tokens/verify`);
  probes.push({
    id: "read.tokenVerify",
    checks: "Which kind of token the run used (user-owned or account-owned)",
    kind: "read",
    result: userVerify.ok || accountVerify.ok ? "ok" : "error",
    observation: { userTokenVerifies: userVerify.ok, accountTokenVerifies: accountVerify.ok },
  });
  const invalid = await raw("GET", `/accounts/${seg(account)}`, { bearer: INVALID_TOKEN });
  const classified = new CloudflareApiError("probe", invalid.status, invalid.codes);
  probes.push({
    id: "read.invalidCredentialCodes",
    checks: "The Cloudflare codes returned for an unusable credential (errors.ts CREDENTIAL_CODES)",
    kind: "read",
    result: "ok",
    httpStatus: invalid.status,
    cloudflareCodes: invalid.codes,
    observation: { installerTreatsAsCredentialFailure: classified.code === "unauthenticated" || classified.code === "forbidden" },
  });
  await probe("read.listSubscriptions", "Billing: Read (or account:read) covers listSubscriptions; which rate plan IDs qualify", "read",
    () => api.listSubscriptions(account), (subs) => ({ ratePlanIds: subs.map((s) => s.ratePlanId).toSorted() }));
  let zoneId: string | undefined;
  if (options.zone === undefined) {
    skip("read.findZone", "Zone: Read covers findZone", "read", "no --zone given");
    skip("read.listDnsRecords", "DNS: Read covers listDnsRecords", "read", "no --zone given");
  } else {
    const zone = await probe("read.findZone", "Zone: Read covers findZone", "read",
      () => api.findZone(account, options.zone!), (z) => ({ found: z !== undefined, status: z?.status ?? "absent" }));
    zoneId = zone?.id;
    if (zoneId === undefined) skip("read.listDnsRecords", "DNS: Read covers listDnsRecords", "read", "zone not found");
    else await probe("read.listDnsRecords", "DNS: Read covers listDnsRecords", "read",
      () => api.listDnsRecords(zoneId!, `${name}.${options.zone}`), (records) => ({ records: records.length }));
  }
  await probe("read.listWorkerScripts", "Workers Scripts: Edit covers listWorkerScripts", "read", () => api.listWorkerScripts(account), (s) => ({ count: s.length }));
  await probe("read.listWorkerDomains", "Workers Scripts: Edit covers listWorkerDomains", "read", () => api.listWorkerDomains(account), (d) => ({ count: d.length }));
  await probe("read.listKvNamespaces", "Workers KV Storage: Edit covers listKvNamespaces", "read", () => api.listKvNamespaces(account), (n) => ({ count: n.length }));
  await probe("read.listR2Buckets", "Workers R2 Storage: Edit covers listR2Buckets; R2-not-enabled is code 10042", "read", () => api.listR2Buckets(account), (b) => ({ count: b.length }));
  await probe("read.listD1Databases", "D1: Edit covers listD1Databases", "read", () => api.listD1Databases(account), (d) => ({ count: d.length }));
  await probe("read.getAccessOrganization", "Access: Organizations, Identity Providers, and Groups: Read covers the organization", "read",
    () => api.getAccessOrganization(account), (org) => ({ organizationExists: org !== undefined }));
  await probe("read.listAccessIdentityProviders", "Access: Organizations, Identity Providers, and Groups: Read covers identity providers", "read",
    () => api.listAccessIdentityProviders(account), (idps) => ({ types: [...new Set(idps.map((i) => i.type))].toSorted() }));
  await probe("read.listAccessPolicies", "Access: Apps and Policies: Edit (or Read) covers reusable policies", "read", () => api.listAccessPolicies(account), (p) => ({ count: p.length }));
  await probe("read.listAccessApplications", "Access: Apps and Policies: Edit (or Read) covers applications", "read", () => api.listAccessApplications(account), (a) => ({ count: a.length }));
  await probe("read.listAiGateways", "AI Gateway: Edit (or Read) covers listAiGateways", "read", () => api.listAiGateways(account), (g) => ({ count: g.length }));

  const writes: { id: string; checks: string; needsZone?: boolean; run: () => Promise<void> }[] = [
    {
      id: "write.kvNamespace",
      checks: "Workers KV Storage: Edit covers createKvNamespace",
      run: async () => {
        const ns = await probe("write.kvNamespace", "Workers KV Storage: Edit covers createKvNamespace", "create-delete", () => api.createKvNamespace(account, name));
        if (ns) onCleanup(`kv:${ns.id}`, () => raw("DELETE", `/accounts/${seg(account)}/storage/kv/namespaces/${seg(ns.id)}`));
      },
    },
    {
      id: "write.r2Bucket",
      checks: "Workers R2 Storage: Edit covers createR2Bucket; code 10042 when R2 is not enabled",
      run: async () => {
        const bucket = await probe("write.r2Bucket", "Workers R2 Storage: Edit covers createR2Bucket; code 10042 when R2 is not enabled", "create-delete", () => api.createR2Bucket(account, name));
        if (bucket) onCleanup(`r2:${bucket.name}`, () => raw("DELETE", `/accounts/${seg(account)}/r2/buckets/${seg(bucket.name)}`));
      },
    },
    {
      id: "write.d1Batch",
      checks: "A multi-statement D1 /query with params runs as one batch, and a failing statement rolls back the others",
      run: async () => {
        const db = await probe("write.d1Database", "D1: Edit covers createD1Database", "create-delete", () => api.createD1Database(account, name));
        if (!db) return skip("write.d1Batch", "A multi-statement D1 /query with params runs as one batch", "create-delete", "the probe database could not be created");
        onCleanup(`d1:${db.uuid}`, () => raw("DELETE", `/accounts/${seg(account)}/d1/database/${seg(db.uuid)}`));
        const count = async (table: string) => {
          const rows = await api.queryD1(account, db.uuid, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?1", [table]);
          return Number(rows[0]?.["n"] ?? -1);
        };
        let acceptedWithParams = true;
        try {
          await api.queryD1(account, db.uuid, "CREATE TABLE probe_ok (v TEXT); INSERT INTO probe_ok (v) VALUES (?1);", ["ok"]);
        } catch (error) {
          if (!(error instanceof CloudflareApiError)) throw error;
          acceptedWithParams = false;
        }
        const okRows = acceptedWithParams ? Number((await api.queryD1(account, db.uuid, "SELECT count(*) AS n FROM probe_ok"))[0]?.["n"] ?? -1) : -1;
        let failingBatchRejected = false;
        try {
          await api.queryD1(account, db.uuid, "CREATE TABLE probe_partial (v TEXT); INSERT INTO probe_partial (v) VALUES (?1); INSERT INTO probe_missing (v) VALUES (?1);", ["x"]);
        } catch (error) {
          if (!(error instanceof CloudflareApiError)) throw error;
          failingBatchRejected = true;
        }
        const partialTables = await count("probe_partial");
        probes.push({
          id: "write.d1Batch",
          checks: "A multi-statement D1 /query with params runs as one batch, and a failing statement rolls back the others",
          kind: "create-delete",
          result: "ok",
          observation: {
            multiStatementWithParamsAccepted: acceptedWithParams,
            rowsWrittenByMultiStatement: okRows,
            failingBatchRejected,
            // 0 means the batch was atomic: the CREATE before the failing INSERT was rolled back.
            tablesLeftByFailingBatch: partialTables,
            atomic: failingBatchRejected && partialTables === 0,
          },
        });
      },
    },
    {
      id: "write.workerScript",
      checks: "Workers Scripts: Edit covers upload, secrets and versions; version detail exposes plain-text vars",
      run: async () => {
        const uploaded = await probe("write.workerScript", "Workers Scripts: Edit covers uploadWorkerScript", "create-delete", () =>
          api.uploadWorkerScript(account, name, {
            metadata: {
              main_module: "probe.mjs",
              compatibility_date: "2026-10-01",
              compatibility_flags: [],
              bindings: [{ type: "plain_text", name: PROBE_VAR, text: PROBE_VAR_VALUE }],
              keep_bindings: [],
              observability: { enabled: false },
            },
            modules: [{ name: "probe.mjs", type: "esm", bytes: new TextEncoder().encode(PROBE_WORKER_SOURCE) }],
          }).then(() => true));
        if (!uploaded) return;
        onCleanup(`worker:${name}`, () => raw("DELETE", `/accounts/${seg(account)}/workers/scripts/${seg(name)}?force=true`));
        await probe("write.workerSecret", "Workers Scripts: Edit covers putWorkerSecret and listWorkerSecrets", "create-delete", async () => {
          await api.putWorkerSecret(account, name, "SCHOOLOS_PROBE_SECRET", crypto.randomUUID());
          return await api.listWorkerSecrets(account, name);
        }, (names) => ({ secretListed: names.includes("SCHOOLOS_PROBE_SECRET") }));
        await probe("write.workerVersions", "Version detail responses expose plain-text binding values (rollback depends on it)", "create-delete",
          () => api.listWorkerVersions(account, name),
          (versions) => ({ versions: versions.length, plainTextVarsExposed: versions.some((v) => v.vars[PROBE_VAR] === PROBE_VAR_VALUE) }));
        if (zoneId === undefined) {
          skip("write.workerDomain", "PUT /workers/domains accepts the `environment` field", "create-delete", "no --zone given, or the zone was not found");
          return;
        }
        const domain = await probe("write.workerDomain", "PUT /workers/domains accepts the `environment` field; Workers Routes: Edit on the zone", "create-delete",
          () => api.attachWorkerDomain(account, { hostname: `${name}.${options.zone}`, service: name, zoneId: zoneId! }),
          (d) => ({ attached: d.hostname === `${name}.${options.zone}` }));
        if (domain) onCleanup(`domain:${domain.hostname}`, () => raw("DELETE", `/accounts/${seg(account)}/workers/domains/${seg(domain.id)}`));
      },
    },
    {
      id: "write.access",
      checks: "Access: Apps and Policies: Edit covers creating a reusable policy and a self-hosted application",
      run: async () => {
        const policy = await probe("write.accessPolicy", "Access: Apps and Policies: Edit covers createAccessPolicy", "create-delete", () =>
          api.createAccessPolicy(account, { name, decision: "allow", include: [{ email_domain: { domain: "probe.example" } }] }));
        if (policy) onCleanup(`access-policy:${policy.id}`, () => raw("DELETE", `/accounts/${seg(account)}/access/policies/${seg(policy.id)}`));
        if (!policy) return;
        if (zoneId === undefined) {
          skip("write.accessApplication", "Access: Apps and Policies: Edit covers createAccessApplication", "create-delete", "no --zone given, or the zone was not found");
          return;
        }
        const app = await probe("write.accessApplication", "Access: Apps and Policies: Edit covers createAccessApplication", "create-delete", () =>
          api.createAccessApplication(account, { name, domain: `${name}.${options.zone}`, type: "self_hosted", sessionDuration: "1h", policyIds: [policy.id] }),
          (a) => ({ audienceIssued: a.aud.length > 0 }));
        if (app) onCleanup(`access-app:${app.id}`, () => raw("DELETE", `/accounts/${seg(account)}/access/apps/${seg(app.id)}`));
      },
    },
    {
      id: "write.aiGateway",
      checks: "AI Gateway: Edit covers createAiGateway",
      run: async () => {
        const gateway = await probe("write.aiGateway", "AI Gateway: Edit covers createAiGateway", "create-delete", () => api.createAiGateway(account, name));
        if (gateway) onCleanup(`ai-gateway:${gateway.id}`, () => raw("DELETE", `/accounts/${seg(account)}/ai-gateway/gateways/${seg(gateway.id)}`));
      },
    },
  ];

  const cleanup: CleanupRecord[] = [];
  if (!options.apply) {
    for (const write of writes) skip(write.id, write.checks, "create-delete", "dry run; pass --apply to create and delete probe resources", "planned");
  } else {
    try {
      for (const write of writes) await write.run();
    } finally {
      for (const item of cleanups.toReversed()) {
        const response = await item.run();
        // A resource already gone (404) counts as deleted.
        const deleted = response.ok || response.status === 404;
        cleanup.push({ resource: item.resource, deleted, ...(deleted ? {} : { httpStatus: response.status, cloudflareCodes: response.codes }) });
      }
    }
  }

  return {
    schema: "schoolos.verify-account/v1",
    runId: options.runId,
    startedAt: (options.now?.() ?? new Date()).toISOString(),
    accountId: account,
    mode: options.apply ? "apply" : "dry-run",
    ...(options.zone === undefined ? {} : { zone: options.zone }),
    probes,
    cleanup,
    leftovers: cleanup.filter((c) => !c.deleted).map((c) => c.resource),
  };
}

function seg(value: string): string {
  return encodeURIComponent(value);
}
