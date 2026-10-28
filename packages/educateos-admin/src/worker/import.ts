// The import of educateos.io's operators, installations and slug reservations into this admin's D1
// (SCHO-263, hosted edition). The source is the control plane's read-only export, over the site
// Worker's RPC entrypoint (`ControlPlaneExporter`); this file never sees anything else of it.
//
// Idempotent: it compares what the export says with what D1 holds and writes only the difference,
// in one batch, so a second run with nothing new writes nothing. A dry run plans the same writes
// and reports them without applying any. Each installation maps onto one workspace (origin
// `https://<hostname>`): an existing workspace with the same slug and origin is matched, and
// otherwise a pending one is made with its own ops key, as an enrollment would, ready to be
// registered at the district. A workspace that has only the slug, or only the origin, is left
// alone and the installation is reported as skipped.
//
// What crosses: operators' Access subjects, emails (the operators' own) and account IDs, and each
// installation's slug, hostname, Cloudflare account, release and time. No district data: the
// control plane never held any.
import { ControlPlaneExport } from "@educateos/control-plane/export";
import { SigningIdentity } from "@educateos/fleet/ops";
import type { ImportCounts, ImportReport, Workspace } from "../shared/api.ts";
import { sealPrivateKey } from "./keys.ts";
import type { AdminStore, ImportWrites, InstallationRow, ReservationRow } from "./store.ts";

/** Where the export comes from: the control plane's RPC entrypoint, or a fake in tests. */
export interface ControlPlaneSource {
  exportSnapshot(): Promise<unknown>;
}

/** The export didn't come, or wasn't one. */
export class ImportSourceError extends Error {
  override readonly name = "ImportSourceError";
}

/** What {@link importControlPlane} is given. */
export interface ImportOptions {
  store: AdminStore;
  source: ControlPlaneSource;
  /** Seals the ops keys of workspaces the import makes. Not called on a dry run. */
  keyEncryptionKey: () => Promise<CryptoKey>;
  dryRun: boolean;
  now: Date;
  /** Makes a workspace ID. */
  newWorkspaceId: () => string;
}

const counts = (): ImportCounts => ({ created: 0, updated: 0, unchanged: 0 });

const sameInstallation = (a: InstallationRow, b: Omit<InstallationRow, "importedAt">) =>
  a.workspaceId === b.workspaceId && a.operatorSub === b.operatorSub && a.slug === b.slug && a.hostname === b.hostname &&
  a.cloudflareAccountId === b.cloudflareAccountId && a.releaseVersion === b.releaseVersion && a.installedAt === b.installedAt;

const sameReservation = (a: ReservationRow, b: Omit<ReservationRow, "importedAt">) =>
  a.operatorSub === b.operatorSub && a.cloudflareAccountId === b.cloudflareAccountId && a.instanceId === b.instanceId && a.leaseUntil === b.leaseUntil;

/** Reads the export, plans the writes, and applies them unless this is a dry run. */
export async function importControlPlane(options: ImportOptions): Promise<ImportReport> {
  const { store, now } = options;
  let raw: unknown;
  try {
    raw = await options.source.exportSnapshot();
  } catch {
    throw new ImportSourceError("educateos.io's control plane could not be reached.");
  }
  const parsed = ControlPlaneExport.safeParse(raw);
  if (!parsed.success) throw new ImportSourceError("educateos.io's export is not in a format this admin reads.");
  const snapshot = parsed.data;
  const at = now.toISOString();

  const [operators, workspaces, installations, reservations] = await Promise.all([
    store.operatorImportRows(), store.allWorkspaces(), store.installationRows(), store.reservationRows(),
  ]);
  const writes: ImportWrites = { newOperators: [], operatorAccounts: [], workspaces: [], installations: [], reservations: [], removedReservations: [] };
  const report: ImportReport = {
    dryRun: options.dryRun,
    exportedAt: snapshot.exportedAt,
    operators: counts(),
    workspaces: { created: 0, matched: 0 },
    installations: counts(),
    reservations: { ...counts(), removed: 0 },
    skipped: [],
  };

  // Operators: new ones come in as `installer`; ADMINS still decides who may use this admin. A known
  // operator keeps their email and role here, and gains their control-plane account ID.
  const knownOperators = new Map(operators.map((row) => [row.sub, row]));
  for (const operator of snapshot.operators) {
    const known = knownOperators.get(operator.subject);
    if (known === undefined) {
      writes.newOperators.push({ sub: operator.subject, email: operator.email, accountId: operator.accountId, firstSeenAt: operator.firstSeenAt, lastSeenAt: operator.lastSeenAt });
      report.operators.created++;
    } else if (known.accountId !== operator.accountId || operator.firstSeenAt < known.firstSeenAt) {
      writes.operatorAccounts.push({ sub: operator.subject, accountId: operator.accountId, firstSeenAt: operator.firstSeenAt });
      report.operators.updated++;
    } else {
      report.operators.unchanged++;
    }
  }

  // Installations, each onto a workspace. The workspace list grows as the plan makes new ones, so two
  // installations in one export can't both claim a slug.
  const allWorkspaces: Workspace[] = [...workspaces];
  const linked = new Set(installations.flatMap((row) => (row.workspaceId === undefined ? [] : [row.workspaceId])));
  const knownInstallations = new Map(installations.map((row) => [row.instanceId, row]));
  const pendingKeys: { workspace: Workspace }[] = [];
  for (const { operatorSubject, installation } of snapshot.installations) {
    const known = knownInstallations.get(installation.instanceId);
    let workspaceId = known?.workspaceId;
    if (workspaceId === undefined) {
      const origin = `https://${installation.hostname}`;
      const match = allWorkspaces.find((w) => w.slug === installation.slug && w.origin === origin && !linked.has(w.id));
      if (match !== undefined) {
        workspaceId = match.id;
        report.workspaces.matched++;
      } else if (allWorkspaces.some((w) => w.slug === installation.slug)) {
        report.skipped.push({ instanceId: installation.instanceId, slug: installation.slug, reason: "slug-taken" });
      } else if (allWorkspaces.some((w) => w.origin === origin)) {
        report.skipped.push({ instanceId: installation.instanceId, slug: installation.slug, reason: "origin-taken" });
      } else {
        const workspace: Workspace = {
          id: options.newWorkspaceId(),
          slug: installation.slug,
          // The control plane never asked for the district's name; the slug stands in until it is renamed.
          displayName: installation.slug,
          origin,
          // A guided install runs in the operator's own Cloudflare account: self-hosted.
          edition: "oss",
          enrolledAt: installation.installedAt,
          status: "pending",
        };
        allWorkspaces.push(workspace);
        pendingKeys.push({ workspace });
        workspaceId = workspace.id;
        report.workspaces.created++;
      }
      if (workspaceId !== undefined) linked.add(workspaceId);
    }
    const row = {
      instanceId: installation.instanceId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      operatorSub: operatorSubject,
      slug: installation.slug,
      hostname: installation.hostname,
      cloudflareAccountId: installation.accountId,
      releaseVersion: installation.releaseVersion,
      installedAt: installation.installedAt,
    };
    if (known === undefined) {
      writes.installations.push({ ...row, importedAt: at });
      report.installations.created++;
    } else if (!sameInstallation(known, row)) {
      writes.installations.push({ ...row, importedAt: at });
      report.installations.updated++;
    } else {
      report.installations.unchanged++;
    }
  }

  // Reservations mirror the Durable Object, which stays authoritative: one released there is
  // removed here.
  const knownReservations = new Map(reservations.map((row) => [row.slug, row]));
  const exportedSlugs = new Set(snapshot.reservations.map((reservation) => reservation.slug));
  for (const reservation of snapshot.reservations) {
    const row = {
      slug: reservation.slug,
      operatorSub: reservation.operatorSubject,
      cloudflareAccountId: reservation.accountId,
      instanceId: reservation.instanceId,
      ...(reservation.leaseUntil === null ? {} : { leaseUntil: reservation.leaseUntil }),
    };
    const known = knownReservations.get(reservation.slug);
    if (known === undefined) {
      writes.reservations.push({ ...row, importedAt: at });
      report.reservations.created++;
    } else if (!sameReservation(known, row)) {
      writes.reservations.push({ ...row, importedAt: at });
      report.reservations.updated++;
    } else {
      report.reservations.unchanged++;
    }
  }
  for (const slug of knownReservations.keys()) {
    if (!exportedSlugs.has(slug)) {
      writes.removedReservations.push(slug);
      report.reservations.removed++;
    }
  }

  if (options.dryRun) return report;

  // Keys are made only for a real run, so a dry run needs no encryption key and leaves no trace.
  if (pendingKeys.length > 0) {
    const kek = await options.keyEncryptionKey();
    for (const { workspace } of pendingKeys) {
      const identity = await SigningIdentity.generate();
      writes.workspaces.push({
        workspace,
        key: {
          workspaceId: workspace.id,
          keyId: identity.keyId,
          publicJwk: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: identity.publicKey, kid: identity.keyId }),
          sealedPrivateKey: await sealPrivateKey(kek, workspace.id, identity),
          createdAt: at,
        },
      });
    }
  }
  await store.applyImport(writes);
  return report;
}
