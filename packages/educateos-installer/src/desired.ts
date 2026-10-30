// Compiles a pinned release manifest plus a district install config into the desired resource
// graph. Every placeholder in the manifest's closed vocabulary (manifest-lib.ts header) is
// resolved here: values the installer chooses ($ACCOUNT_ID, $PUBLIC_BASE_URL, $WORKER_NAME, R2
// bucket names) become literals, and values only Cloudflare can mint (KV namespace and D1
// database IDs, the Access audience tag) become references to the resource that will produce
// them, which is also a dependency edge. A `$` token outside the vocabulary fails compilation,
// as the deploy-side renderer must.
import { EducateOsError } from "@educateos/contracts";
import type { AccessPolicySpec } from "./cloudflare-api.ts";
import {
  type DistrictInstallConfig,
  publicHostname,
  resourcePrefix,
  workerScriptName,
  WorkerScriptName,
} from "./config.ts";
import { managedHostname } from "./slug.ts";
import type {
  AssetManifestEntry,
  D1Migration,
  DurableObjectMigration,
  ManifestModule,
  ReleaseManifest,
  WorkerEntry,
} from "./manifest.ts";

/** Names one desired resource, e.g. `kv:BLUEPRINTS` or `worker:router`. Stable across releases. */
export type ResourceKey = string;

/** A value Cloudflare mints when it creates another resource. */
export interface OutputRef {
  readonly ref: ResourceKey;
  readonly output: "id" | "aud";
}

/** A rendered value that may still wait on another resource's output. */
export type TemplateValue = string | number | boolean | null | OutputRef | TemplateValue[] | { [key: string]: TemplateValue };

/** A binding in a desired Worker, whose field values may be {@link OutputRef}s. */
export type DesiredBinding = { type: string; name: string } & Record<string, TemplateValue>;

interface ResourceBase {
  key: ResourceKey;
  /** Resources this one needs to exist (and whose outputs it may read) first. */
  dependsOn: ResourceKey[];
}

/** A KV namespace, named by its binding. */
export interface DesiredKvNamespace extends ResourceBase {
  kind: "kv_namespace";
  title: string;
}

/** An R2 bucket, named by its binding. */
export interface DesiredR2Bucket extends ResourceBase {
  kind: "r2_bucket";
  name: string;
}

/** A D1 database and the release's migrations for it, in order. */
export interface DesiredD1Database extends ResourceBase {
  kind: "d1_database";
  name: string;
  migrations: D1Migration[];
}

/** The optional AI Gateway. */
export interface DesiredAiGateway extends ResourceBase {
  kind: "ai_gateway";
  gatewayId: string;
}

/** The Access policy admitting the district's email domains. */
export interface DesiredAccessPolicy extends ResourceBase {
  kind: "access_policy";
  spec: AccessPolicySpec;
}

/** The Access application in front of the public hostname, and the managed hostname if any. */
export interface DesiredAccessApplication extends ResourceBase {
  kind: "access_application";
  name: string;
  domain: string;
  /** `domain`, then the managed hostname. One application, so one audience for both. */
  destinations: string[];
  sessionDuration: string;
  policyKey: ResourceKey;
}

/** One Worker script of the release. */
export interface DesiredWorker extends ResourceBase {
  kind: "worker_script";
  pkgName: string;
  scriptName: string;
  role: WorkerEntry["kind"];
  mainModule: string;
  modules: ManifestModule[];
  compatibilityDate?: string;
  compatibilityFlags: string[];
  observability: Record<string, unknown>;
  /** The full Durable Object migration history; the reconciler uploads the steps not yet applied. */
  migrations: DurableObjectMigration[];
  bindings: DesiredBinding[];
  assets?: {
    manifest: Record<string, AssetManifestEntry>;
    config: Record<string, unknown>;
  };
}

/** A secret on one Worker. Its value comes from the secret source at apply time, never the plan. */
export interface DesiredWorkerSecret extends ResourceBase {
  kind: "worker_secret";
  pkgName: string;
  scriptName: string;
  secretName: string;
}

/**
 * A service the config disabled: its Worker must not exist. It runs after the backend, so the
 * backend's binding to it is gone before the Worker is deleted.
 */
export interface DesiredRetiredWorker extends ResourceBase {
  kind: "worker_retired";
  pkgName: string;
  scriptName: string;
}

/** The public hostname, attached to the router as a Workers custom domain. */
export interface DesiredCustomDomain extends ResourceBase {
  kind: "custom_domain";
  hostname: string;
  zoneName: string;
  scriptName: string;
}

/**
 * The managed default hostname, `<slug>.educateos.io`, an alias routed to the router (ADR-0013
 * addendum A1). Planning picks the path from observation: a Workers custom domain when the managed
 * zone is in the district's account, otherwise a Cloudflare for SaaS custom hostname on the
 * district's own zone, whose validation records the managed zone publishes (managed-zone.ts).
 *
 * It is two resources, so an alias is never served without the Access application covering it.
 * `release` runs before the application is updated and removes every managed hostname routing to
 * the router except `hostname`; `attach` runs after it and adds `hostname`.
 */
export interface DesiredManagedHostname extends ResourceBase {
  kind: "managed_hostname";
  phase: "release" | "attach";
  /** The alias the config wants, or null for none. */
  hostname: string | null;
  scriptName: string;
  /** The district's own zone, which holds the custom hostname on the cross-account path. */
  zoneName: string;
}

/** One node of the desired resource graph. */
export type DesiredResource =
  | DesiredKvNamespace
  | DesiredR2Bucket
  | DesiredD1Database
  | DesiredAiGateway
  | DesiredAccessPolicy
  | DesiredAccessApplication
  | DesiredWorker
  | DesiredWorkerSecret
  | DesiredRetiredWorker
  | DesiredCustomDomain
  | DesiredManagedHostname;

/**
 * A deploy input an installed service needs. Var values come from the config, so whether one is
 * supplied is known here; secrets come from the {@link SecretSource} and preflight checks them.
 */
export type DesiredInput =
  | { pkgName: string; name: string; label: string; kind: "var"; supplied: boolean }
  | { pkgName: string; name: string; label: string; kind: "secret" };

/** The compiled desired state of one instance at one release. */
export interface DesiredState {
  instanceId: string;
  accountId: string;
  releaseId: string;
  hostname: string;
  /** The deploy inputs of every installed service, for preflight. */
  inputs: DesiredInput[];
  /** Every resource, in an order where each comes after everything it depends on. */
  resources: DesiredResource[];
}

/** Plain-text vars the installer adds to every Worker it owns. */
export const MARKER_VARS = {
  /** Ownership: the instance the Worker belongs to. A Worker without it is not the installer's. */
  instance: "EDUCATEOS_INSTANCE_ID",
  /** The release the Worker version came from; how rollback finds the previous release's version. */
  release: "EDUCATEOS_RELEASE_ID",
  /** The digest of everything uploaded; equal digests mean nothing to upload. */
  digest: "EDUCATEOS_DEPLOY_DIGEST",
} as const;

/** The asset variant the router serves. EducateOS always sits behind Access. */
export const ASSET_VARIANT = "access";

/** The Access session length the application is created with. */
export const ACCESS_SESSION_DURATION = "12h";

/** Keys of the singleton resources. */
export const RESOURCE_KEYS = {
  accessPolicy: "access:policy",
  accessApplication: "access:application",
  aiGateway: "ai-gateway",
  customDomain: "domain:public",
  managedHostnameRelease: "domain:managed:release",
  managedHostname: "domain:managed",
} as const;

/** The resource key of a release package's Worker. */
export function workerKey(pkgName: string): ResourceKey {
  return `worker:${pkgName}`;
}

/** The resource key of a disabled service's Worker, which must not exist. */
export function retiredWorkerKey(pkgName: string): ResourceKey {
  return `retired:${pkgName}`;
}

/** Whether a value is an {@link OutputRef}. */
export function isOutputRef(value: unknown): value is OutputRef {
  return typeof value === "object" && value !== null && "ref" in value && "output" in value;
}

/** Fails compilation: the release and the config do not fit together. */
function invalid(message: string): never {
  throw new EducateOsError("validation-failed", message);
}

const PLACEHOLDER = /\$[A-Z][A-Z0-9_]*(?:\([^)]*\))?/g;

/** Turns a binding name into the part of a resource name it contributes. */
function nameSuffix(binding: string): string {
  return binding.toLowerCase().replaceAll("_", "-");
}

/**
 * The plain-text vars a gatekeeper's non-secret deploy inputs become, from the config's values.
 * Every `var` and `workerName` input needs a value; a value for anything else is refused, so a
 * secret can't be put in the (non-secret) config by mistake and a typo can't go unnoticed.
 */
function gatekeeperInputVars(pkgName: string, entry: WorkerEntry, config: DistrictInstallConfig): Record<string, string> {
  const supplied = config.gatekeeperInputs[pkgName] ?? {};
  const inputs = new Map((entry.inputs ?? []).map((input) => [input.name, input]));
  for (const name of Object.keys(supplied)) {
    const input = inputs.get(name);
    if (!input) invalid(`${pkgName} declares no deploy input ${name}`);
    if (input.kind === "secret") invalid(`${pkgName}: ${name} is a secret; supply it as a secret, never in the install config`);
  }
  const vars: Record<string, string> = {};
  for (const input of inputs.values()) {
    if (input.kind === "secret") continue;
    const value = supplied[input.name];
    if (value === undefined) invalid(`${pkgName} needs a value for ${input.name} (${input.label}) in gatekeeperInputs`);
    if (input.kind === "workerName" && !WorkerScriptName.safeParse(value).success) {
      invalid(`${pkgName}: ${input.name} must be a Worker name`);
    }
    vars[input.name] = value;
  }
  return vars;
}

/**
 * Compiles the desired state. Installs the backend, the router, every preinstalled gatekeeper and
 * the gatekeepers the config names, with the config's values for their non-secret deploy inputs;
 * refuses a named gatekeeper that is not installable or whose inputs the config does not fit.
 *
 * Services the config enables are installed with their `var` inputs from the config and their
 * secrets from the secret source, and the backend gains the manifest's `backendBinding` to each,
 * after the service Worker and its secrets exist. Services the config disables become
 * {@link DesiredRetiredWorker}s ordered after the backend, so the binding goes before the Worker.
 */
export function compileDesiredState(manifest: ReleaseManifest, config: DistrictInstallConfig): DesiredState {
  if (manifest.releaseId !== config.release.releaseId) invalid("manifest and config pin different releases");
  const hostname = publicHostname(config);
  const alias = config.managedHostname ? managedHostname(config.managedHostname.slug) : null;
  const publicBaseUrl = `https://${hostname}`;
  const prefix = resourcePrefix(config);

  const entries = Object.entries(manifest.workers);
  const backend = entries.filter(([, w]) => w.kind === "backend");
  const router = entries.filter(([, w]) => w.kind === "router");
  if (backend.length !== 1 || router.length !== 1) invalid("release must contain exactly one backend and one router");
  const [backendPkg] = backend[0]!;
  const [routerPkg] = router[0]!;

  const gatekeepers = new Set(entries.filter(([, w]) => w.kind === "gatekeeper" && w.preinstall).map(([name]) => name));
  for (const name of config.gatekeepers) {
    const entry = manifest.workers[name];
    if (!entry || entry.kind !== "gatekeeper") invalid(`release has no gatekeeper ${name}`);
    if (!entry.installable) invalid(`${name} is not installable on district instances`);
    gatekeepers.add(name);
  }
  for (const name of Object.keys(config.gatekeeperInputs)) {
    if (!gatekeepers.has(name)) invalid(`gatekeeperInputs names ${name}, which this install does not include`);
  }
  const installed = [...gatekeepers].toSorted();

  const services: string[] = [];
  const retired: DesiredRetiredWorker[] = [];
  const inputs: DesiredInput[] = [];
  for (const [name, wanted] of Object.entries(config.services).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (!wanted.enabled) {
      // Removal needs only the Worker's name, so it works with a release that no longer ships it.
      retired.push({ kind: "worker_retired", key: retiredWorkerKey(name), dependsOn: [workerKey(backendPkg)], pkgName: name, scriptName: workerScriptName(config, name) });
      continue;
    }
    const entry = manifest.workers[name];
    if (!entry || entry.kind !== "service") invalid(`release has no service ${name}`);
    if (!entry.installable) invalid(`${name} is not installable on district instances`);
    if (!entry.backendBinding) invalid(`service ${name} has no backendBinding`);
    const declared = new Map((entry.inputs ?? []).map((input) => [input.name, input]));
    for (const input of declared.values()) {
      if (input.kind === "workerName") invalid(`${name} needs a workerName input, which the installer does not collect yet`);
      inputs.push(input.kind === "var"
        ? { pkgName: name, name: input.name, label: input.label, kind: "var", supplied: Object.hasOwn(wanted.vars, input.name) }
        : { pkgName: name, name: input.name, label: input.label, kind: "secret" });
    }
    for (const varName of Object.keys(wanted.vars)) {
      if (declared.get(varName)?.kind !== "var") invalid(`${name} has no var input ${varName}`);
    }
    services.push(name);
  }
  // The signed asset variant selects a school deployment, but enforcement is backend-owned.
  const schoolBuild = Boolean(router[0]![1].assetsConfig?.variants["access-school"]);
  if (schoolBuild) {
    const policy = backend[0]![1].bindings.find(binding => binding.type === "service" &&
      binding.name === "WORKSHOP_CAPABILITY_POLICY");
    if (!policy) invalid("school release requires a district WORKSHOP_CAPABILITY_POLICY binding");
  }
  const scriptNames = new Map([backendPkg, routerPkg, ...installed, ...services].map((pkg) => [pkg, workerScriptName(config, pkg)]));

  const storage = new Map<ResourceKey, DesiredResource>();
  const workers: DesiredResource[] = [];
  const secrets: DesiredResource[] = [];

  const accessPolicy: DesiredAccessPolicy = {
    kind: "access_policy",
    key: RESOURCE_KEYS.accessPolicy,
    dependsOn: [],
    spec: {
      name: `${prefix}-members`,
      decision: "allow",
      include: config.access.allowedEmailDomains.map((domain) => ({ email_domain: { domain } })),
    },
  };
  const accessApplication: DesiredAccessApplication = {
    kind: "access_application",
    key: RESOURCE_KEYS.accessApplication,
    // A released alias is gone before the application stops listing it.
    dependsOn: [accessPolicy.key, RESOURCE_KEYS.managedHostnameRelease],
    name: prefix,
    domain: hostname,
    destinations: alias ? [hostname, alias] : [hostname],
    sessionDuration: ACCESS_SESSION_DURATION,
    policyKey: accessPolicy.key,
  };
  const aiGateway: DesiredAiGateway | undefined = config.aiGateway
    ? { kind: "ai_gateway", key: RESOURCE_KEYS.aiGateway, dependsOn: [], gatewayId: prefix }
    : undefined;

  for (const pkgName of [...installed, ...services, backendPkg, routerPkg]) {
    const entry = manifest.workers[pkgName]!;
    const dependsOn = new Set<ResourceKey>();
    const resolve = (value: string): TemplateValue => {
      let ref: OutputRef | undefined;
      const literal = value.replace(PLACEHOLDER, (token) => {
        const kv = /^\$KV_([A-Z0-9_]+)_ID$/.exec(token);
        const d1 = /^\$D1_([A-Z0-9_]+)_ID$/.exec(token);
        const r2 = /^\$R2_([A-Z0-9_]+)_NAME$/.exec(token);
        const worker = /^\$WORKER_NAME\(([a-z0-9-]+)\)$/.exec(token);
        if (token === "$ACCOUNT_ID") return config.accountId;
        if (token === "$PUBLIC_BASE_URL") return publicBaseUrl;
        if (r2) {
          const key = `r2:${r2[1]}`;
          const name = `${prefix}-${nameSuffix(r2[1]!)}`;
          storage.set(key, { kind: "r2_bucket", key, dependsOn: [], name });
          dependsOn.add(key);
          return name;
        }
        if (worker) {
          const target = scriptNames.get(worker[1]!);
          if (!target) invalid(`${pkgName} binds ${worker[1]}, which this install does not include`);
          dependsOn.add(workerKey(worker[1]!));
          return target;
        }
        if (kv || d1) {
          if (token !== value) invalid(`${pkgName}: ${token} must be a whole value`);
          const binding = (kv ?? d1)![1]!;
          const key = kv ? `kv:${binding}` : `d1:${binding}`;
          if (kv) storage.set(key, { kind: "kv_namespace", key, dependsOn: [], title: `${prefix}-${nameSuffix(binding)}` });
          else if (!storage.has(key)) {
            storage.set(key, { kind: "d1_database", key, dependsOn: [], name: `${prefix}-${nameSuffix(binding)}`, migrations: [] });
          }
          dependsOn.add(key);
          ref = { ref: key, output: "id" };
          return token;
        }
        return invalid(`${pkgName}: unknown placeholder ${token}`);
      });
      return ref ?? literal;
    };
    const resolveDeep = (value: unknown): TemplateValue => {
      if (typeof value === "string") return resolve(value);
      if (Array.isArray(value)) return value.map(resolveDeep);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveDeep(v)]));
      }
      if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
      return invalid(`${pkgName}: unsupported value in manifest`);
    };

    const bindings: DesiredBinding[] = [];
    for (const binding of entry.bindings) {
      if (binding.type === "secret_text") {
        if (binding.text !== `$SECRET(${binding.name})`) invalid(`${pkgName}: secret ${binding.name} must be $SECRET(${binding.name})`);
        secrets.push({
          kind: "worker_secret",
          key: `secret:${pkgName}:${binding.name}`,
          dependsOn: [workerKey(pkgName)],
          pkgName,
          scriptName: scriptNames.get(pkgName)!,
          secretName: binding.name,
        });
        continue;
      }
      bindings.push(resolveDeep(binding) as DesiredBinding);
    }

    if (schoolBuild && pkgName === backendPkg) {
      const requirement = bindings.find(binding => binding.name === "REQUIRE_WORKSHOP_CAPABILITY_POLICY");
      if (requirement) {
        if (requirement.type !== "plain_text" || requirement.text !== "true") {
          invalid("school release must require Workshop capability policy");
        }
      } else {
        bindings.push({ type: "plain_text", name: "REQUIRE_WORKSHOP_CAPABILITY_POLICY", text: "true" });
      }
    }

    // Gatekeepers are reached through GATEKEEPER_<SLUG> service bindings on the backend and router.
    if (entry.gatekeeperBindingExpansion) {
      const { entrypoint, propsByPackage } = entry.gatekeeperBindingExpansion;
      for (const gatekeeper of installed) {
        const slug = manifest.workers[gatekeeper]!.shortName;
        if (!slug) invalid(`${gatekeeper} has no shortName`);
        const props = propsByPackage[gatekeeper];
        bindings.push({
          type: "service",
          name: `GATEKEEPER_${slug.toUpperCase()}`,
          service: scriptNames.get(gatekeeper)!,
          ...(entrypoint ? { entrypoint } : {}),
          ...(props ? { props: resolveDeep(props) } : {}),
        });
        dependsOn.add(workerKey(gatekeeper));
      }
    }

    // Optional services are bound by the backend once they and their secrets exist.
    if (entry.kind === "backend") {
      for (const service of services) {
        const { name, entrypoint } = manifest.workers[service]!.backendBinding!;
        if (bindings.some((b) => b.name === name)) invalid(`${service}'s backend binding ${name} collides with an existing backend binding`);
        bindings.push({ type: "service", name, service: scriptNames.get(service)!, entrypoint });
        dependsOn.add(workerKey(service));
        for (const secret of secrets) if (secret.kind === "worker_secret" && secret.pkgName === service) dependsOn.add(secret.key);
      }
    }

    // Operator values are literal: they are never placeholder-resolved, so no `$` in them is read.
    const inputVars = entry.kind === "gatekeeper" ? gatekeeperInputVars(pkgName, entry, config) : {};
    const vars: Record<string, unknown> = {
      ...entry.vars,
      [MARKER_VARS.instance]: config.instanceId,
      [MARKER_VARS.release]: manifest.releaseId,
    };
    if (entry.kind === "backend") {
      // The instance-state vars the hosted deploy service would inject (see manifest-lib).
      vars.ADMINS = config.admins;
      vars.CF_ACCESS_ISS = `https://${config.access.teamName}.cloudflareaccess.com`;
      dependsOn.add(accessApplication.key);
      if (aiGateway) {
        vars.CF_AI_GATEWAY = aiGateway.gatewayId;
        vars.CF_AI_GATEWAY_ACCOUNT_ID = config.accountId;
        dependsOn.add(aiGateway.key);
      }
    }
    for (const [name, value] of Object.entries(vars).toSorted(([a], [b]) => a.localeCompare(b))) {
      const resolved = resolveDeep(value);
      bindings.push(typeof resolved === "string" ? { type: "plain_text", name, text: resolved } : { type: "json", name, json: resolved });
    }
    for (const [name, text] of Object.entries(inputVars).toSorted(([a], [b]) => a.localeCompare(b))) {
      if (Object.hasOwn(vars, name)) invalid(`${pkgName}: input ${name} would replace a var the release or installer sets`);
      bindings.push({ type: "plain_text", name, text });
    }
    if (entry.kind === "backend") {
      bindings.push({ type: "plain_text", name: "CF_ACCESS_AUD", text: { ref: accessApplication.key, output: "aud" } });
    }
    if (entry.kind === "service") {
      // Operator-supplied values are literal: a `$` in them is not a placeholder.
      for (const [name, text] of Object.entries(config.services[pkgName]!.vars).toSorted(([x], [y]) => x.localeCompare(y))) {
        if (bindings.some((b) => b.name === name)) invalid(`${pkgName}: input ${name} collides with a binding the release declares`);
        bindings.push({ type: "plain_text", name, text });
      }
    }

    for (const migration of entry.d1Migrations ?? []) {
      const db = storage.get(`d1:${migration.binding}`);
      if (db?.kind !== "d1_database") invalid(`${pkgName}: D1 migration ${migration.id} names unbound ${migration.binding}`);
      db.migrations.push(migration);
    }

    let assets: DesiredWorker["assets"];
    if (entry.assetsConfig) {
      const school = entry.assetsConfig.variants["access-school"];
      if (school && entry.assetsConfig.variants[ASSET_VARIANT]) invalid(`${pkgName} has ambiguous Access asset variants`);
      const variant = school ?? entry.assetsConfig.variants[ASSET_VARIANT];
      if (!variant) invalid(`${pkgName} has no "${ASSET_VARIANT}" asset variant`);
      assets = {
        manifest: variant.manifest,
        config: {
          ...(entry.assetsConfig.not_found_handling ? { not_found_handling: entry.assetsConfig.not_found_handling } : {}),
          ...(entry.assetsConfig.run_worker_first ? { run_worker_first: entry.assetsConfig.run_worker_first } : {}),
        },
      };
    }

    workers.push({
      kind: "worker_script",
      key: workerKey(pkgName),
      dependsOn: [...dependsOn].toSorted(),
      pkgName,
      scriptName: scriptNames.get(pkgName)!,
      role: entry.kind,
      mainModule: entry.mainModule,
      modules: entry.modules,
      ...(entry.compatibilityDate ? { compatibilityDate: entry.compatibilityDate } : {}),
      compatibilityFlags: entry.compatibilityFlags,
      observability: entry.observability,
      migrations: entry.migrations,
      bindings,
      ...(assets ? { assets } : {}),
    });
  }

  for (const resource of storage.values()) {
    if (resource.kind === "d1_database") {
      const ids = resource.migrations.map((m) => m.id);
      if (new Set(ids).size !== ids.length) invalid(`${resource.name} has duplicate migration IDs`);
      resource.migrations.sort((a, b) => a.id.localeCompare(b.id));
    }
  }

  const customDomain: DesiredCustomDomain = {
    kind: "custom_domain",
    key: RESOURCE_KEYS.customDomain,
    dependsOn: [workerKey(routerPkg)],
    hostname,
    zoneName: config.baseDomain,
    scriptName: scriptNames.get(routerPkg)!,
  };

  const managed = { kind: "managed_hostname" as const, hostname: alias, scriptName: scriptNames.get(routerPkg)!, zoneName: config.baseDomain };
  const releaseManaged: DesiredManagedHostname = { ...managed, key: RESOURCE_KEYS.managedHostnameRelease, dependsOn: [], phase: "release" };
  // Attaching waits for the router and for the application that protects the alias.
  const attachManaged: DesiredManagedHostname | undefined = alias
    ? { ...managed, key: RESOURCE_KEYS.managedHostname, dependsOn: [workerKey(routerPkg), accessApplication.key], phase: "attach" }
    : undefined;

  const resources = topologicalOrder([
    ...[...storage.values()].toSorted((a, b) => a.key.localeCompare(b.key)),
    ...(aiGateway ? [aiGateway] : []),
    accessPolicy,
    accessApplication,
    ...workers,
    ...secrets,
    ...retired,
    customDomain,
    releaseManaged,
    ...(attachManaged ? [attachManaged] : []),
  ]);
  return { instanceId: config.instanceId, accountId: config.accountId, releaseId: manifest.releaseId, hostname, inputs, resources };
}

/** Orders resources so each follows its dependencies, keeping input order otherwise. Rejects cycles. */
export function topologicalOrder<T extends { key: ResourceKey; dependsOn: ResourceKey[] }>(resources: T[]): T[] {
  const byKey = new Map(resources.map((r) => [r.key, r]));
  const state = new Map<ResourceKey, "visiting" | "done">();
  const out: T[] = [];
  const visit = (resource: T) => {
    const seen = state.get(resource.key);
    if (seen === "done") return;
    if (seen === "visiting") invalid(`dependency cycle through ${resource.key}`);
    state.set(resource.key, "visiting");
    for (const dep of resource.dependsOn) {
      const target = byKey.get(dep);
      if (!target) invalid(`${resource.key} depends on unknown ${dep}`);
      visit(target);
    }
    state.set(resource.key, "done");
    out.push(resource);
  };
  for (const resource of resources) visit(resource);
  return out;
}
