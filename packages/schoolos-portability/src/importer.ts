import { z } from "zod";
import { ArtifactId, ContentDigest, ID_PREFIXES, PrincipalId, SchoolOsError, WorkspaceId, type ArtifactType, type Caller } from "@schoolos/contracts";
import { sha256Digest, type AiAssistance, type LearningArtifacts, type RevisionContentInput } from "@schoolos/learning-artifacts";
import type { WorkspaceDirectory } from "@schoolos/workspaces";
import { ExportId, type ArtifactRecord, type WorkContext } from "./archive.ts";
import { consentGrantDigest, sameParty, TransferConsent, TransferConsentId, TransferItemClass, TransferParty } from "./consent.ts";
import type { PortableIdentityLinkStore } from "./identity-link.ts";
import { findSecretShapes } from "./secrets.ts";
import { Ed25519PublicKey, SignedEnvelope, verifyEnvelope } from "./signing.ts";
import { TransferStatement } from "./transfer.ts";
import { validateArchive, type ValidatedArchive } from "./validate.ts";

/** How a transfer reached the destination: carried by the learner as a file, or pushed by the source district. */
export const TransferChannelKind = z.enum(["learner-carried", "direct"]);
/** A transfer channel kind. */
export type TransferChannelKind = z.infer<typeof TransferChannelKind>;

/** A source district whose agent key the destination admin has pinned. */
export const PinnedSource = z.strictObject({
  label: TransferParty.shape.label,
  instanceId: TransferParty.shape.instanceId,
  publicKey: Ed25519PublicKey,
});
/** A pinned source. */
export type PinnedSource = z.infer<typeof PinnedSource>;

/** The destination admin's import policy. */
export const DestinationImportPolicy = z.strictObject({
  /** This district, as consents name it. */
  self: TransferParty,
  /** The item classes this district accepts. Anything else in an archive is skipped. */
  acceptedItemClasses: z.array(TransferItemClass),
  /** Sources whose packages must carry a valid signature by the pinned key. */
  pinnedSources: z.array(PinnedSource),
  /** Whether a learner-carried file from a source that is not pinned is imported, marked `unverified-source`. */
  acceptUnverifiedSources: z.boolean(),
});
/** A destination import policy. */
export type DestinationImportPolicy = z.infer<typeof DestinationImportPolicy>;

/** Whether the source of an import was proven by a pinned key's signature. */
export const SourceVerification = z.enum(["verified", "unverified-source"]);
/** A source verification. */
export type SourceVerification = z.infer<typeof SourceVerification>;

/** Why an item in an accepted archive was not imported. */
export const SkipReason = z.enum(["not-consented", "not-accepted-by-district", "link-host-not-approved"]);
/** A skip reason. */
export type SkipReason = z.infer<typeof SkipReason>;

/**
 * What one import did, kept by the destination: the provenance of every artifact it created (the
 * source district's label and the archive's digest), and the map from archive-local IDs to the
 * fresh local artifact IDs. It is keyed by the archive digest, which makes import idempotent.
 */
export const ImportRecord = z.strictObject({
  archiveDigest: ContentDigest,
  exportId: ExportId,
  source: TransferParty,
  sourceVerification: SourceVerification,
  channel: TransferChannelKind,
  consentId: TransferConsentId,
  targetPrincipalId: PrincipalId,
  /** The target's personal workspace, which holds everything imported. */
  workspaceId: WorkspaceId,
  importedAt: z.iso.datetime(),
  imported: z.array(z.strictObject({ item: z.string(), itemClass: TransferItemClass, artifactId: ArtifactId })),
  skipped: z.array(z.strictObject({ item: z.string(), itemClass: TransferItemClass, reason: SkipReason })),
});
/** An import record. */
export type ImportRecord = z.infer<typeof ImportRecord>;

/** The outcome of an import: done now, or done before for the same archive. */
export interface ImportResult {
  outcome: "imported" | "already-imported";
  record: ImportRecord;
}

/** Where a destination keeps its import records, one per archive digest. */
export interface ImportLedger {
  /** The completed import of an archive, if any. */
  get(archiveDigest: ContentDigest): Promise<ImportRecord | undefined>;
  /** Reserves an archive digest for an import. False if it is already reserved or imported. */
  reserve(archiveDigest: ContentDigest): Promise<boolean>;
  /** Records a reserved import as complete. */
  complete(record: ImportRecord): Promise<void>;
  /** Releases a reservation whose import failed. */
  release(archiveDigest: ContentDigest): Promise<void>;
}

/** An {@link ImportLedger} held in memory, for tests and the local harness. */
export class InMemoryImportLedger implements ImportLedger {
  readonly #records = new Map<string, ImportRecord | "reserved">();

  async get(archiveDigest: ContentDigest): Promise<ImportRecord | undefined> {
    const record = this.#records.get(archiveDigest);
    return record === undefined || record === "reserved" ? undefined : structuredClone(record);
  }

  async reserve(archiveDigest: ContentDigest): Promise<boolean> {
    if (this.#records.has(archiveDigest)) return false;
    this.#records.set(archiveDigest, "reserved");
    return true;
  }

  async complete(record: ImportRecord): Promise<void> {
    this.#records.set(record.archiveDigest, ImportRecord.parse(record));
  }

  async release(archiveDigest: ContentDigest): Promise<void> {
    if (this.#records.get(archiveDigest) === "reserved") this.#records.delete(archiveDigest);
  }

  /** Every completed record. */
  all(): ImportRecord[] {
    return [...this.#records.values()].filter((r) => r !== "reserved").map((r) => structuredClone(r));
  }
}

/** Who an import is for, and how it arrived. */
export interface ImportTarget {
  /** The destination principal receiving the work: the uploading learner, or the linked learner of a direct push. */
  principal: Caller;
  channel: TransferChannelKind;
}

/** What a {@link StudentArchiveImporter} is built from. It has no client for the root, and needs none. */
export interface StudentArchiveImporterOptions {
  /** The destination's artifact service. Everything is created through it, as the target. */
  artifacts: LearningArtifacts;
  /** The destination's workspace directory, for the target's personal workspace. */
  workspaces: WorkspaceDirectory;
  /** The admin's import policy. */
  policy: DestinationImportPolicy;
  /** Confirmed portable identity links. */
  links: PortableIdentityLinkStore;
  /** Import records. */
  ledger: ImportLedger;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

/**
 * District ID shapes from `@schoolos/contracts` and `@schoolos/learning-artifacts` (`rev_`). An
 * archive holds only export-local IDs, so one of these in any record or text is a leak. A hyphen
 * is required in the body, as every minted ID has, so a variable such as `sub_total` in a learner's
 * code does not match.
 */
const INTERNAL_ID = new RegExp(`\\b(?:${[...Object.values(ID_PREFIXES), "rev"].join("|")})_[a-z0-9]+-[a-z0-9-]+`);

const utf8 = new TextDecoder("utf-8", { fatal: true });
const latin1 = new TextDecoder("latin1");


/**
 * Imports `.schoolos` archives from other districts (roadmap P02). Nothing on this path reaches the
 * root (ADR-0001): the archive arrives from the learner or straight from the source district, and
 * the source is proven by a key the destination admin pinned, not by anything the root says.
 */
export class StudentArchiveImporter {
  readonly #artifacts: LearningArtifacts;
  readonly #workspaces: WorkspaceDirectory;
  readonly #policy: DestinationImportPolicy;
  readonly #links: PortableIdentityLinkStore;
  readonly #ledger: ImportLedger;
  readonly #now: () => Date;

  constructor(options: StudentArchiveImporterOptions) {
    this.#artifacts = options.artifacts;
    this.#workspaces = options.workspaces;
    this.#policy = DestinationImportPolicy.parse(options.policy);
    this.#links = options.links;
    this.#ledger = options.ledger;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Imports an archive into the target's personal workspace, in order:
   *
   * 1. `validateArchive`, and a further screen that refuses the whole archive if any record or
   *    content holds a district ID or secret-shaped text, binary content included;
   * 2. the source's signature, required when the source is pinned. An unsigned or unpinned file is
   *    accepted only if it was learner-carried and the policy accepts unverified sources, and it is
   *    marked `unverified-source`;
   * 3. the consent: for this archive and this district, unrevoked and unexpired;
   * 4. the destination policy, which with the consent decides which item classes are imported;
   * 5. the target: a confirmed identity link for the archive's learner must name the target, and a
   *    direct push needs one.
   *
   * Every item becomes a new artifact with a fresh local ID in the target's personal workspace, so
   * it is `personal-private`: never course work, and not visible to teachers. Importing the same
   * archive again returns the first import.
   */
  async importStudentArchive(
    bytes: Uint8Array<ArrayBuffer>,
    rawSignature: SignedEnvelope | undefined,
    rawConsent: TransferConsent,
    target: ImportTarget,
  ): Promise<ImportResult> {
    const channel = TransferChannelKind.parse(target.channel);
    const consent = parseOrRefuse(TransferConsent, rawConsent, "consent");
    const signature = rawSignature === undefined ? undefined : parseOrRefuse(SignedEnvelope, rawSignature, "signature");

    const archive = await validateArchive(bytes);
    screenForImport(archive);
    const archiveDigest = await sha256Digest(bytes);
    const { manifest } = archive;

    const sourceVerification = await this.#verifySource(signature, consent, archiveDigest, channel);

    const now = this.#now().toISOString();
    if (consent.exportId !== manifest.exportId || consent.subject !== manifest.subject) refuse("forbidden", "This consent is for another archive.");
    if (consent.source.label !== manifest.district.displayName) refuse("forbidden", "This consent was given in another district.");
    if (!sameParty(consent.destination, this.#policy.self)) refuse("forbidden", "This consent is for a transfer to another district.");
    if (consent.revokedAt !== undefined) refuse("forbidden", "This consent has been withdrawn.");
    if (now < consent.grantedAt || now >= consent.expiresAt) refuse("forbidden", "This consent is not in effect.");

    const accepted = new Set(this.#policy.acceptedItemClasses);
    const consented = new Set(consent.itemClasses);
    if (!consent.itemClasses.some((c) => accepted.has(c))) refuse("policy-violation", "This district accepts none of the consented items.");

    const learner = target.principal.principal.principalId;
    const link = await this.#links.find(consent.source.label, manifest.subject);
    if (link !== undefined && link.destinationPrincipalId !== learner) refuse("forbidden", "This archive is linked to another learner.");
    if (link === undefined && channel === "direct") refuse("forbidden", "A direct transfer needs an administrator-confirmed link to the learner.");

    const existing = await this.#ledger.get(archiveDigest);
    if (existing !== undefined) {
      if (existing.targetPrincipalId !== learner) refuse("conflict", "This archive was already imported for someone else.");
      return { outcome: "already-imported", record: existing };
    }
    if (!(await this.#ledger.reserve(archiveDigest))) refuse("conflict", "This archive is already being imported.");

    const created: ArtifactId[] = [];
    try {
      const workspace = await this.#workspaces.ensurePersonalWorkspace(target.principal);
      const run = new ImportRun(this.#artifacts, target.principal, workspace.id, archive, created);
      const classOf = (itemClass: TransferItemClass): SkipReason | undefined =>
        !consented.has(itemClass) ? "not-consented" : !accepted.has(itemClass) ? "not-accepted-by-district" : undefined;
      const record: ImportRecord = ImportRecord.parse({
        archiveDigest,
        exportId: manifest.exportId,
        source: consent.source,
        sourceVerification,
        channel,
        consentId: consent.id,
        targetPrincipalId: learner,
        workspaceId: workspace.id,
        importedAt: now,
        ...(await run.importAll(classOf)),
      });
      await this.#ledger.complete(record);
      return { outcome: "imported", record };
    } catch (error) {
      for (const id of created) await this.#artifacts.deleteArtifact(target.principal, id).catch(() => {});
      await this.#ledger.release(archiveDigest);
      throw error;
    }
  }

  /** Checks the package's signature when the source is pinned, and decides whether an unverified source is acceptable. */
  async #verifySource(signature: SignedEnvelope | undefined, consent: TransferConsent, archiveDigest: ContentDigest, channel: TransferChannelKind): Promise<SourceVerification> {
    // A source counts as pinned if either its label or its instance ID is, so a file cannot dodge
    // the signature requirement by claiming a pinned district's name under another instance ID.
    const pinned = this.#policy.pinnedSources.filter((p) =>
      p.label === consent.source.label || (p.instanceId !== undefined && p.instanceId === consent.source.instanceId));
    if (pinned.length === 0) {
      if (channel === "direct") refuse("forbidden", "Direct transfers are accepted only from pinned districts.");
      if (!this.#policy.acceptUnverifiedSources) refuse("policy-violation", "This district accepts transfers only from districts it has pinned.");
      return "unverified-source";
    }
    if (signature === undefined) refuse("forbidden", "Transfers from this district must be signed.");
    let verified = false;
    for (const source of pinned) {
      if (await verifyEnvelope(signature, "student-transfer", source.publicKey)) verified = true;
    }
    if (!verified) refuse("forbidden", "This transfer's signature is not valid.");
    const statement = TransferStatement.safeParse(signature.payload);
    if (!statement.success) refuse("forbidden", "This transfer's signature is not valid.");
    const s = statement.data;
    const matches = s.archiveDigest === archiveDigest && s.exportId === consent.exportId && s.subject === consent.subject &&
      s.consentId === consent.id && s.consentDigest === (await consentGrantDigest(consent)) &&
      s.source.label === consent.source.label && s.source.instanceId === consent.source.instanceId &&
      sameParty(s.destination, consent.destination);
    if (!matches) refuse("forbidden", "This transfer's signature does not cover this archive and consent.");
    return "verified";
  }
}

function refuse(code: "forbidden" | "validation-failed" | "policy-violation" | "conflict", message: string): never {
  throw new SchoolOsError(code, message);
}

function parseOrRefuse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) refuse("validation-failed", `This transfer's ${what} is malformed.`);
  return parsed.data;
}

/**
 * Refuses an archive that `validateArchive` passed but that still holds a district ID anywhere, or
 * secret-shaped text in binary content, which validation does not screen.
 */
function screenForImport(archive: ValidatedArchive): void {
  const records = [archive.manifest, archive.provenance, ...archive.artifacts, ...archive.submissions, ...archive.feedback, ...archive.resources];
  if (records.some((r) => INTERNAL_ID.test(JSON.stringify(r)))) refuse("validation-failed", "This archive holds district identifiers, so it is not imported.");
  for (const path of contentPaths(archive)) {
    const bytes = archive.content(path);
    let text: string;
    try {
      text = utf8.decode(bytes);
    } catch {
      text = latin1.decode(bytes);
    }
    if (INTERNAL_ID.test(text)) refuse("validation-failed", "This archive holds district identifiers, so it is not imported.");
    if (findSecretShapes(text).length > 0) refuse("validation-failed", "This archive holds what looks like a password, key or token, so it is not imported.");
  }
}

function contentPaths(archive: ValidatedArchive): string[] {
  return [
    ...archive.artifacts.flatMap((a) => a.revisions.flatMap((r) => (r.content.kind === "file" ? [r.content.path] : []))),
    ...archive.submissions.flatMap((s) => s.parts.flatMap((p) => (p.content.kind === "file" ? [p.content.path] : []))),
    ...archive.resources.flatMap((r) => (r.content === undefined ? [] : [r.content.path])),
  ];
}

type Imported = Pick<ImportRecord, "imported" | "skipped">;

/** One import's writes into the target's personal workspace. */
class ImportRun {
  readonly #artifacts: LearningArtifacts;
  readonly #caller: Caller;
  readonly #workspaceId: WorkspaceId;
  readonly #archive: ValidatedArchive;
  readonly #created: ArtifactId[];
  readonly #result: Imported = { imported: [], skipped: [] };

  constructor(artifacts: LearningArtifacts, caller: Caller, workspaceId: WorkspaceId, archive: ValidatedArchive, created: ArtifactId[]) {
    this.#artifacts = artifacts;
    this.#caller = caller;
    this.#workspaceId = workspaceId;
    this.#archive = archive;
    this.#created = created;
  }

  async importAll(skipReason: (itemClass: TransferItemClass) => SkipReason | undefined): Promise<Imported> {
    const archive = this.#archive;
    const source = archive.manifest.district.displayName;
    const titles = new Map(archive.artifacts.map((a) => [a.id, a.title]));
    const activities = new Map(archive.submissions.map((s) => [s.id, s.activity]));
    const each = async <T extends { id: string }>(itemClass: TransferItemClass, items: T[], write: (item: T) => Promise<void>) => {
      const reason = skipReason(itemClass);
      for (const item of items) {
        if (reason === undefined) await write(item);
        else this.#result.skipped.push({ item: item.id, itemClass, reason });
      }
    };

    await each("artifacts", archive.artifacts, (a) => this.#artifact(a));
    await each("submissions", archive.submissions, async (s) => {
      const lines = [`# Submission: ${s.activity}`, "", `Submitted ${s.submittedAt}, ${describe(s.context)}, at ${source}.`, ""];
      for (const [index, part] of s.parts.entries()) {
        const n = index + 1;
        if (part.content.kind === "revision") {
          lines.push(`- Part ${n}: "${titles.get(part.content.artifact) ?? part.content.artifact}", revision ${part.content.revision.split("-r")[1]} (${part.digest})`);
        } else if (part.content.kind === "file") {
          const title = clip(`${s.activity}, submitted part ${n}`);
          await this.#create(s.id, "submissions", typeFor(part.content.mediaType), title, [this.#file(part.content.path, part.content.mediaType)]);
          lines.push(`- Part ${n}: imported as "${title}" (${part.digest})`);
        } else {
          lines.push(`- Part ${n}: not included in the archive (${part.digest})`);
        }
      }
      await this.#create(s.id, "submissions", "evidence", clip(`Submission: ${s.activity}`), [markdown(lines)]);
    });
    await each("feedback", archive.feedback, async (f) => {
      const about = f.submission === undefined ? undefined : activities.get(f.submission);
      const heading = about === undefined ? "Feedback" : `Feedback on ${about}`;
      await this.#create(f.id, "feedback", "document", clip(heading), [markdown([`# ${heading}`, "", `Shared by ${f.author} at ${source}, ${f.createdAt}.`, "", f.body])]);
    });
    await each("resources", archive.resources, async (r) => {
      if (r.content !== undefined) {
        await this.#create(r.id, "resources", typeFor(r.content.mediaType), r.title, [this.#file(r.content.path, r.content.mediaType)]);
      } else if (r.reference !== undefined) {
        await this.#create(r.id, "resources", "document", r.title, [markdown([`# ${r.title}`, "", `A resource cited at ${source}: ${r.reference.url}`])]);
      }
    });
    return this.#result;
  }

  async #artifact(record: ArtifactRecord): Promise<void> {
    const revisions = record.revisions.map((revision) => ({
      content: revision.content.kind === "file"
        ? this.#file(revision.content.path, revision.mediaType).content
        : { kind: "external" as const, url: revision.content.url, ...(revision.content.snapshotDigest === undefined ? {} : { snapshotDigest: revision.content.snapshotDigest }) },
      aiAssistance: revision.aiAssistance,
    }));
    try {
      await this.#create(record.id, "artifacts", record.type, record.title, revisions);
    } catch (error) {
      // The destination decides which document hosts a link may point at; a link to a host it has
      // not approved is reported rather than failing the whole import.
      if (record.type === "external-ref" && error instanceof SchoolOsError && error.code === "validation-failed") {
        this.#result.skipped.push({ item: record.id, itemClass: "artifacts", reason: "link-host-not-approved" });
        return;
      }
      throw error;
    }
  }

  /** Creates one artifact from its revisions, oldest first, and records it. */
  async #create(item: string, itemClass: TransferItemClass, type: ArtifactType, title: string, revisions: { content: RevisionContentInput; aiAssistance: AiAssistance }[]): Promise<void> {
    const [first, ...rest] = revisions;
    if (first === undefined) return;
    const view = await this.#artifacts.createArtifact(this.#caller, { workspaceId: this.#workspaceId, type, title, ...first });
    this.#created.push(view.artifact.id);
    for (const revision of rest) await this.#artifacts.saveRevision(this.#caller, view.artifact.id, revision);
    this.#result.imported.push({ item, itemClass, artifactId: view.artifact.id });
  }

  #file(path: string, mediaType: string): { content: RevisionContentInput; aiAssistance: { level: "none" } } {
    const bytes = this.#archive.content(path);
    const content: RevisionContentInput = mediaType.startsWith("text/") ? { kind: "text", mediaType, text: utf8.decode(bytes) } : { kind: "bytes", mediaType, bytes };
    return { content, aiAssistance: { level: "none" } };
  }
}

function markdown(lines: string[]): { content: RevisionContentInput; aiAssistance: { level: "none" } } {
  return { content: { kind: "text", mediaType: "text/markdown", text: lines.join("\n") }, aiAssistance: { level: "none" } };
}

function typeFor(mediaType: string): ArtifactType {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  return "document";
}

function describe(context: WorkContext): string {
  return context.kind === "personal" ? "in a personal workspace" : `in ${context.course}, ${context.section}, ${context.term}`;
}

function clip(title: string): string {
  return title.length <= 200 ? title : `${title.slice(0, 199)}…`;
}
