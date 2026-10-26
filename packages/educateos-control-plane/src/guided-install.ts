// The guided install (SCHO-206): `@educateos/installer` run by educateos.io into the operator's own
// Cloudflare account, with a scoped API token the operator pastes once.
//
// The token lives only in the request that runs the install. It is wrapped in the installer's
// static token provider, sent only to api.cloudflare.com, never stored, logged or echoed, and the
// reference is dropped when the run ends. Cloudflare's OAuth would make it a revocable grant rather
// than a token, but no public OAuth client is registered yet (SCHO-67), so the page also tells the
// operator to delete the token afterwards. educateos.io keeps no standing access either way.
//
// The release comes from educateos.io's release bucket and is verified against the release keys
// the control plane pins, exactly as the installer CLI verifies one: the signed statement against
// the pinned keys, then the manifest bytes against the statement. The installation then runs in
// the operator's account and never needs educateos.io again (ADR-0013).
import { CommercialAccountId, EducateOsError, type InstanceId } from "@educateos/contracts";
import {
  type CloudflareApi,
  CloudflareHttpApi,
  DistrictInstallConfig,
  DistrictSlug,
  install,
  InstallerHaltedError,
  loadPinnedManifest,
  managedHostname,
  type ReleaseArtifacts,
  type RegistryEndpoint,
  staticSecretSource,
  staticTokenProvider,
  type TokenProvider,
} from "@educateos/installer";
import { ReleaseTrust } from "@educateos/releases";
import { z } from "zod";
import type { RegistryReply } from "./registry.ts";
import type { Installation, Operator, Reservation } from "./store.ts";

/** The part of an R2 bucket the release source reads. The Worker's `R2Bucket` binding satisfies it. */
export interface ReleaseBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  list(options: { prefix: string; delimiter: string; cursor?: string }): Promise<{
    delimitedPrefixes: string[];
    truncated: boolean;
    cursor?: string;
  }>;
}

/** A release in the bucket, ready to verify. */
export interface PublishedRelease {
  releaseId: string;
  manifestBytes: Uint8Array<ArrayBuffer>;
  signedManifest: unknown;
}

const RELEASE_ID = /^r\d{6}-[0-9a-f]{7,40}$/;

/**
 * The newest published release. Release IDs start with a zero-padded sequence number, so the
 * greatest ID is the newest. Only `releases/` is read, never `candidates/`: a candidate isn't
 * signed until it passes the release gate (release-signing.md).
 */
export async function latestRelease(bucket: ReleaseBucket): Promise<PublishedRelease | undefined> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "releases/", delimiter: "/", ...(cursor ? { cursor } : {}) });
    ids.push(...page.delimitedPrefixes.map((prefix) => prefix.slice("releases/".length, -1)).filter((id) => RELEASE_ID.test(id)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  const releaseId = ids.toSorted().at(-1);
  if (releaseId === undefined) return undefined;
  const [manifest, signed] = await Promise.all([
    bucket.get(`releases/${releaseId}/manifest.json`),
    bucket.get(`releases/${releaseId}/manifest.signed.json`),
  ]);
  if (manifest === null || signed === null) return undefined;
  return {
    releaseId,
    manifestBytes: new Uint8Array(await manifest.arrayBuffer()),
    signedManifest: JSON.parse(new TextDecoder().decode(await signed.arrayBuffer())) as unknown,
  };
}

/** The release's module and asset blobs, read from the bucket. The installer checks each one's hash. */
export function bucketArtifacts(bucket: ReleaseBucket): ReleaseArtifacts {
  const read = async (key: string) => {
    const object = await bucket.get(key);
    if (object === null) throw new EducateOsError("not-found", `release blob ${key} is missing`);
    return new Uint8Array(await object.arrayBuffer());
  };
  return { blob: (sha256) => read(`blobs/modules/${sha256}`), asset: (hash) => read(`blobs/assets/${hash}`) };
}

function list(item: z.ZodType<string, string>) {
  return z.string()
    .transform((text) => text.split(/[\s,]+/).map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== ""))
    .pipe(z.array(item).min(1).max(20));
}

const Domain = z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "expected a domain name");

/** What the operator enters on the install form. */
export const GuidedInstallForm = z.object({
  slug: z.string().trim().toLowerCase().pipe(DistrictSlug),
  accountId: z.string().trim().toLowerCase().pipe(z.string().regex(/^[0-9a-f]{32}$/, "expected a 32-character Cloudflare account ID")),
  baseDomain: z.string().trim().toLowerCase().pipe(Domain),
  accessTeam: z.string().trim().toLowerCase().pipe(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "expected your Zero Trust team name")),
  allowedEmailDomains: list(Domain),
  admins: list(z.email()),
  register: z.literal("on").optional().transform((value) => value === "on"),
  token: z.string().trim().regex(/^[A-Za-z0-9_-]{30,200}$/, "expected a Cloudflare API token"),
});
/** A parsed install form. */
export type GuidedInstallForm = z.infer<typeof GuidedInstallForm>;

/** The form fields shown back to the operator when the form is rejected. The token never is. */
export const ECHOED_FIELDS = ["slug", "accountId", "baseDomain", "accessTeam", "allowedEmailDomains", "admins"] as const;

/**
 * The instance ID proposed for a slug: the slug itself when it fits the installer's 20 characters,
 * else a prefix of it and a suffix hashed from the whole slug, so two long slugs sharing a prefix
 * don't share an ID and the same slug always proposes the same one. The reservation keeps the ID a
 * slug was first installed under, and a re-run uses that.
 */
export async function instanceIdFor(slug: string): Promise<InstanceId> {
  if (slug.length <= 20) return `ins_${slug}` as InstanceId;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(slug)));
  const suffix = Array.from(digest.slice(0, 3), (b) => b.toString(16).padStart(2, "0")).join("");
  return `ins_${slug.slice(0, 13).replace(/-+$/, "")}-${suffix}` as InstanceId;
}

/** What happened during a run, in order, for the progress page. Nothing in it quotes the token. */
export type InstallEvent =
  | { kind: "release"; releaseId: string; version: string }
  | { kind: "step"; action: string; key: string }
  | { kind: "report"; blocking: string[]; warnings: string[]; blocked: string[] }
  | { kind: "registration"; status: string }
  | { kind: "done"; installation: Installation }
  | { kind: "failed"; message: string };

/** What a guided install needs besides the form. */
export interface GuidedInstallDeps {
  operator: Operator;
  bucket: ReleaseBucket;
  /** The release keys educateos.io pins, as JSON (a `ReleaseTrust`). */
  trust: unknown;
  /** Reserves the slug for this run before anything changes (`ControlPlaneStore.reserveInstall`). */
  reserve: (slug: string, accountId: string, proposedInstanceId: string) => Promise<Reservation>;
  /** Ends the run's hold on the slug, giving it back when the run changed nothing. */
  end: (slug: string, release: boolean) => Promise<void>;
  /** Records the finished installation on the operator's dashboard. Resolves to whether it did. */
  record: (installation: Installation) => Promise<boolean>;
  /** Hands a registration to the control plane's registry. */
  register: (envelope: unknown) => Promise<RegistryReply>;
  /** The Cloudflare API the installer drives with the token. Defaults to api.cloudflare.com; tests use the installer's fake. */
  cloudflareApi?: (tokens: TokenProvider) => CloudflareApi;
  now?: () => Date;
}

const item = (entry: { code: string; message: string; operatorAction?: string }) =>
  `${entry.code}: ${entry.message}${entry.operatorAction ? ` ${entry.operatorAction}` : ""}`;

/** Runs one guided install, reporting each event as it happens. Never throws, and never reports the token. */
export async function runGuidedInstall(form: GuidedInstallForm, deps: GuidedInstallDeps, emit: (event: InstallEvent) => void): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const reservation = await deps.reserve(form.slug, form.accountId, await instanceIdFor(form.slug)).catch(() => undefined);
  if (reservation === undefined || !reservation.ok) {
    emit({ kind: "failed", message: reservation === undefined
      ? "educateos.io couldn't reserve the address just now. Try again shortly."
      : reservation.reason === "running"
        ? `An install of ${form.slug}.educateos.io is already running. Wait for it to finish.`
        : `${form.slug}.educateos.io is already taken.` });
    return;
  }
  // Whether the account may have changed: the slug is given back only when it can't have. Once
  // the installer runs, a failure counts as a change, since a step may have half applied.
  let changed = false;
  let installing = false;
  try {
    const release = await latestRelease(deps.bucket);
    if (release === undefined) throw new EducateOsError("unavailable", "No signed release is published yet.");
    // The version is read from the statement here only to pin it; loadPinnedManifest then verifies
    // the statement's signature and that it names this release, version and manifest.
    const version = z.object({ payload: z.object({ version: z.string() }) }).parse(release.signedManifest).payload.version;
    const pin = { mode: "signed" as const, releaseId: release.releaseId, version, trust: ReleaseTrust.parse(deps.trust) };
    const manifest = await loadPinnedManifest(release.manifestBytes, pin, { signedManifest: release.signedManifest, now: now() });
    emit({ kind: "release", releaseId: release.releaseId, version });

    const instanceId = reservation.instanceId as InstanceId;
    const config = DistrictInstallConfig.parse({
      instanceId,
      accountId: form.accountId,
      baseDomain: form.baseDomain,
      subdomain: form.slug,
      access: { teamName: form.accessTeam, allowedEmailDomains: form.allowedEmailDomains },
      admins: form.admins,
      release: pin,
      managedHostname: { slug: form.slug },
      ...(form.register
        ? {
            fleet: {
              districtLabel: form.slug,
              commercialAccountId: CommercialAccountId.parse(deps.operator.accountId),
              contactRole: "district-technology-admin",
              capabilityIds: [],
            },
          }
        : {}),
    });
    const installation: Installation = {
      instanceId, slug: form.slug, hostname: managedHostname(form.slug), accountId: form.accountId,
      releaseVersion: version, installedAt: now().toISOString(),
    };

    // The registry accepts a registration only for an instance its operator installed, so the
    // installation is recorded first. The installer registers only after a successful apply.
    let recorded: boolean | undefined;
    const record = async () => (recorded ??= await deps.record(installation).catch(() => false));
    const registry: RegistryEndpoint = {
      async register(envelope) {
        if (!(await record())) throw new EducateOsError("unavailable", "the installation could not be recorded");
        const reply = await deps.register(envelope);
        if (!reply.ok) throw new EducateOsError(reply.code, reply.message);
        return reply.body;
      },
    };

    installing = true;
    const report = await install({
      api: (deps.cloudflareApi ?? ((tokens) => new CloudflareHttpApi({ tokens })))(staticTokenProvider("district-run", form.token)),
      config,
      manifest,
      artifacts: bucketArtifacts(deps.bucket),
      secrets: staticSecretSource({}),
      registry,
      onStep: (step) => {
        changed = true;
        emit({ kind: "step", action: step.action, key: step.key });
      },
      now,
    });

    emit({
      kind: "report",
      blocking: report.preflight.blocking.map(item),
      warnings: report.preflight.warnings.map(item),
      blocked: (report.plan?.blocked ?? []).map((step) => `${step.key}: ${step.reason}`),
    });
    installing = false;
    if (report.status !== "applied") {
      emit({ kind: "failed", message: report.status === "preflight-blocked"
        ? "Preflight found blocking issues, so nothing was changed."
        : "The plan is blocked, so nothing was changed." });
      return;
    }
    changed = true;
    if (report.registration) emit({ kind: "registration", status: report.registration.status });
    if (!(await record())) {
      emit({ kind: "failed", message: `${installation.hostname} is installed in your account, but educateos.io couldn't record it, so your dashboard won't list it yet. Run the install again to record it.` });
      return;
    }
    emit({ kind: "done", installation });
  } catch (error) {
    changed ||= installing;
    // Installer and EducateOS errors carry safe messages. Anything else is reported by name only,
    // so no stray exception can echo the token.
    const message = error instanceof InstallerHaltedError || error instanceof EducateOsError
      ? `${error.code}: ${error.message}`
      : error instanceof z.ZodError
        ? "The release or the install settings were rejected."
        : `Unexpected ${error instanceof Error ? error.name : "error"}.`;
    emit({ kind: "failed", message });
  } finally {
    await deps.end(form.slug, !changed).catch(() => undefined);
  }
}
