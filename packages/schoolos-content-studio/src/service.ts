import {
  type Action,
  type AuthorizationRequest,
  type Authorizer,
  type DistrictId,
  type PrincipalId,
  type RequestChannel,
  Scope,
  SchoolOsError,
  scopeContains,
} from "@schoolos/contracts";
import { ResourceDescriptor, ResourceId, RightsMode } from "@schoolos/registry";
import { z } from "zod";
import { AlignmentInput, type AlignmentSource } from "./alignments.ts";
import { extractPageMetadata, type PageMetadata } from "./html.ts";
import { ContentItemId, randomIdBody, snapshotDigest } from "./ids.ts";
import type { ClassBinding, ContentItem, ItemSource, StudioRelease } from "./item.ts";
import { interpretLicenseHints } from "./license.ts";
import { assertTransition, type PipelineState, type StudioAuditEvent, USABLE_STATES } from "./pipeline.ts";
import { type AgeAppropriatenessHook, type ContentReviewer, runAiReview, runChecks } from "./review.ts";
import { permittedUses, proposeRightsMode, widens } from "./rights.ts";
import { type ScannerSetting, scanUpload } from "./scanner.ts";
import { type ContentType, declaredContentType, resolveContentType } from "./sniff.ts";
import type { ContentStudioStorage } from "./storage.ts";
import { DEFAULT_URL_IMPORT_LIMITS, fetchForImport, type ImportFetch, type UrlImportLimits } from "./url-fetch.ts";

/** The verified principal a studio call is made for. Built only from trusted server-side identity. */
export type StudioSubject = AuthorizationRequest["subject"];

/** An offering scope: the only scope a class binding can name. */
const OfferingScope = Scope.options[2];

/** A URL submission. `updatesResourceId` marks it as a new revision of an already released resource. */
export const SubmitUrlInput = z.strictObject({
  url: z.string().min(1).max(2048),
  targetScope: Scope,
  updatesResourceId: ResourceId.optional(),
});
/** A URL submission. */
export type SubmitUrlInput = z.infer<typeof SubmitUrlInput>;

/** An upload's description. Its declared media type must agree with the bytes' magic numbers. */
export const SubmitUploadInput = z.strictObject({
  fileName: z.string().trim().min(1).max(255),
  mediaType: z.string().min(1).max(255),
  targetScope: Scope,
  updatesResourceId: ResourceId.optional(),
});
/** An upload's description. */
export type SubmitUploadInput = z.infer<typeof SubmitUploadInput>;

/** A rights mode change, with the reason that is kept in the item's history. */
export const RightsChangeInput = z.strictObject({ mode: RightsMode, reason: z.string().trim().min(1).max(1000) });
/** A rights mode change. */
export type RightsChangeInput = z.infer<typeof RightsChangeInput>;

/** An approval: the alignments the reviewer asserts, each with evidence. */
export const ApproveInput = z.strictObject({ alignments: z.array(AlignmentInput).max(50) });
/** An approval. */
export type ApproveInput = z.infer<typeof ApproveInput>;

/** A rejection, with the reviewer's reason. */
export const RejectInput = z.strictObject({ reason: z.string().trim().min(1).max(2000) });
/** A rejection. */
export type RejectInput = z.infer<typeof RejectInput>;

/** A request to use a release in a class. Without a version, the latest release is bound. */
export const BindInput = z.strictObject({
  resourceId: ResourceId,
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  offering: OfferingScope,
});
/** A binding request. */
export type BindInput = z.infer<typeof BindInput>;

/** One entry in a reviewer's queue. */
export interface QueueEntry {
  itemId: ContentItemId;
  resourceId: ResourceId;
  title: string | undefined;
  source: ItemSource;
  contentType: ContentType;
  targetScope: Scope;
  submittedBy: PrincipalId;
  submittedAt: string;
  proposedRights: RightsMode;
  currentRights: RightsMode;
  /** How many deterministic flags are `blocking`, so the queue can sort the riskiest first. */
  blockingFlags: number;
}

/** Everything a Content Studio needs. Each district runs its own, over its own storage. */
export interface ContentStudioOptions {
  districtId: DistrictId;
  storage: ContentStudioStorage;
  /** Decides every call. {@link contentStudioAuthorizer} implements the C03 rules over a directory. */
  authorizer: Authorizer;
  /** The surface calls arrive through, recorded in authorization requests. */
  channel?: RequestChannel;
  fetch: ImportFetch;
  urlLimits?: UrlImportLimits;
  /** The largest upload accepted, in bytes. */
  maxUploadBytes?: number;
  scanner: ScannerSetting;
  reviewer?: ContentReviewer;
  ageHooks?: readonly AgeAppropriatenessHook[];
  alignments: AlignmentSource;
  /** The current time as an ISO 8601 timestamp. */
  now?: () => string;
}

/** The upload size cap used unless the district sets its own. */
export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new SchoolOsError("validation-failed", `${issue.path.join(".") || "input"}: ${issue.message}`);
}

const sameScope = (a: Scope, b: Scope) => scopeContains(a, b) && scopeContains(b, a);

const NOT_FOUND = () => new SchoolOsError("not-found", "no such content item");

/**
 * The Content Studio: imports a URL or upload into quarantine, parses it, resolves its provenance
 * and rights, reviews it, and turns a human approval into an immutable registry release
 * (roadmap §5.3, PR C03).
 *
 * Imported content is untrusted throughout. It is parsed as data, passed to an AI reviewer only
 * inside a delimited payload, and nothing it says, nor anything the reviewer returns, changes an
 * item's state, rights or alignments: only an authorized person does.
 */
export class ContentStudio {
  readonly #options: ContentStudioOptions;
  readonly #now: () => string;

  constructor(options: ContentStudioOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Imports a URL. The source is fetched before any item exists, so a refused URL records nothing.
   *
   * @throws SchoolOsError `forbidden` if the subject may not submit at the target scope, and
   *   whatever {@link fetchForImport} throws for a refused or failed fetch.
   */
  async submitUrl(subject: StudioSubject, input: unknown): Promise<ContentItem> {
    const { url, targetScope, updatesResourceId } = parseInput(SubmitUrlInput, input);
    await this.#require(subject, "create", targetScope);
    const update = await this.#updateTarget(subject, updatesResourceId, targetScope);
    const fetched = await fetchForImport(url, this.#options.fetch, this.#options.urlLimits ?? DEFAULT_URL_IMPORT_LIMITS);
    return this.#ingest(subject, {
      source: { kind: "url", submittedUrl: url, finalUrl: fetched.finalUrl, hops: fetched.hops },
      contentType: fetched.contentType,
      bytes: fetched.bytes,
      targetScope,
      resourceId: update?.resourceId,
      previousDigest: update?.digest,
      scan: undefined,
    });
  }

  /**
   * Imports an upload. Its type is decided by its magic bytes, which must agree with the declared
   * media type; the file name plays no part.
   *
   * @throws SchoolOsError `policy-violation` for an oversized upload or a type outside the
   *   allowlist or contradicting its bytes; `unavailable` if no scanner is configured or the scan
   *   fails, in which case nothing is stored.
   */
  async submitUpload(subject: StudioSubject, input: unknown, bytes: Uint8Array): Promise<ContentItem> {
    const { fileName, mediaType, targetScope, updatesResourceId } = parseInput(SubmitUploadInput, input);
    await this.#require(subject, "create", targetScope);
    const maxBytes = this.#options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    if (bytes.byteLength > maxBytes) throw new SchoolOsError("policy-violation", `the upload is larger than ${maxBytes} bytes`);
    const declared = declaredContentType(mediaType);
    if (declared === undefined) throw new SchoolOsError("policy-violation", "the upload's type is not accepted");
    const contentType = resolveContentType(declared, bytes);
    if (contentType === undefined) throw new SchoolOsError("policy-violation", "the upload's content does not match its declared type");
    const update = await this.#updateTarget(subject, updatesResourceId, targetScope);
    const scan = await scanUpload(this.#options.scanner, bytes, contentType);
    return this.#ingest(subject, {
      source: { kind: "upload", fileName },
      contentType,
      bytes,
      targetScope,
      resourceId: update?.resourceId,
      previousDigest: update?.digest,
      scan,
    });
  }

  /** The reviewer queue: items awaiting a decision within `scope` that the subject may review. */
  async listQueue(subject: StudioSubject, scope: unknown): Promise<QueueEntry[]> {
    const parsed = parseInput(Scope, scope);
    await this.#require(subject, "list", parsed);
    const entries: QueueEntry[] = [];
    for (const item of await this.#options.storage.listItems()) {
      if (item.state !== "reviewed" || !scopeContains(parsed, item.targetScope)) continue;
      if (!(await this.#allowed(subject, "read", item.targetScope, item.id))) continue;
      entries.push({
        itemId: item.id,
        resourceId: item.resourceId,
        title: item.title,
        source: item.source,
        contentType: item.contentType,
        targetScope: item.targetScope,
        submittedBy: item.submittedBy,
        submittedAt: item.submittedAt,
        proposedRights: item.rights.proposed,
        currentRights: item.rights.current,
        blockingFlags: item.checks?.flags.filter((flag) => flag.severity === "blocking").length ?? 0,
      });
    }
    return entries.toSorted((a, b) => b.blockingFlags - a.blockingFlags || a.submittedAt.localeCompare(b.submittedAt));
  }

  /** An item's review report: provenance, rights and their history, the checks, and any AI findings. */
  async getReport(subject: StudioSubject, itemId: unknown): Promise<ContentItem> {
    return this.#item(subject, itemId, "read");
  }

  /** An item's audit trail. */
  async listAudit(subject: StudioSubject, itemId: unknown): Promise<StudioAuditEvent[]> {
    const item = await this.#item(subject, itemId, "read");
    return this.#options.storage.listAudit(item.id);
  }

  /**
   * Changes an item's rights mode before a decision. Narrowing needs `update`, which a teacher
   * holds for their own offering; widening needs `configure`, which only a curriculum admin holds.
   * Every change is kept with its reason.
   *
   * @throws SchoolOsError `forbidden` for a widening the subject may not make, and `conflict` once
   *   the item has been decided or when the mode is unchanged.
   */
  async setRightsMode(subject: StudioSubject, itemId: unknown, input: unknown): Promise<ContentItem> {
    const { mode, reason } = parseInput(RightsChangeInput, input);
    const item = await this.#item(subject, itemId, "update");
    if (item.decision !== undefined) throw new SchoolOsError("conflict", "rights cannot change after a decision; import a new revision");
    const from = item.rights.current;
    if (from === mode) throw new SchoolOsError("conflict", `the rights mode is already ${mode}`);
    const widened = widens(from, mode);
    if (widened) await this.#require(subject, "configure", item.targetScope, item.id);
    const at = this.#now();
    item.rights = { ...item.rights, current: mode, changes: [...item.rights.changes, { from, to: mode, by: subject.principalId, at, widened, reason }] };
    await this.#audit({ itemId: item.id, type: "rights-changed", actor: subject.principalId, at, detail: `${from} -> ${mode}` });
    await this.#save(item);
    return item;
  }

  /**
   * Approves a reviewed item and creates its immutable release. Alignments must name items of
   * framework releases the district approved.
   *
   * @throws SchoolOsError `not-found` if the subject cannot see the item, `forbidden` if they may
   *   not approve at its scope, `conflict` unless it is awaiting a decision, and
   *   `validation-failed` for an alignment the catalog cannot resolve.
   */
  async approve(subject: StudioSubject, itemId: unknown, input: unknown): Promise<StudioRelease> {
    const { alignments } = parseInput(ApproveInput, input);
    const item = await this.#item(subject, itemId, "approve");
    assertTransition(item.state, "approved");
    const resolved = [];
    for (const alignment of alignments) {
      const competency = await this.#options.alignments.resolve(alignment.frameworkKey, alignment.competencyUri);
      if (competency === undefined) {
        throw new SchoolOsError("validation-failed", `${alignment.competencyUri} is not an item of the district's approved ${alignment.frameworkKey} release`);
      }
      resolved.push({ alignment, competency });
    }
    const previous = await this.#options.storage.listReleases(item.resourceId);
    const major = Math.max(0, ...previous.map((r) => Number(r.descriptor.release.version.split(".")[0])));
    const version = `${major + 1}.0.0`;
    const at = this.#now();
    const review = { reviewer: subject.principalId, reviewedAt: at };
    const verifiedBy = item.rights.changes.findLast((change) => change.widened);
    const descriptor = ResourceDescriptor.safeParse({
      id: item.resourceId,
      release: { version, releasedAt: at, contentDigest: item.snapshotDigest },
      kind: item.contentType === "html" ? "web-page" : "document",
      title: (item.title ?? (item.source.kind === "upload" ? item.source.fileName : item.source.finalUrl)).slice(0, 500),
      locator: locatorOf(item),
      license: {
        name: item.license.status === "recognized" ? item.license.license.name : "No recognized license",
        ...(item.license.status === "recognized" ? { licenseUri: item.license.license.uri } : {}),
        ...(item.checks?.attribution === undefined ? {} : { attribution: item.checks.attribution.slice(0, 2000) }),
        permittedUses: permittedUses(item.rights.current),
        // Rights are verified only by a curriculum admin's explicit widening; otherwise they remain the source's claim.
        verification: verifiedBy !== undefined && verifiedBy.by !== "importer"
          ? { status: "verified", reviewer: verifiedBy.by, reviewedAt: verifiedBy.at }
          : { status: "claimed" },
      },
      audience: {},
      accessibility: { features: [], hazards: [], summary: accessibilitySummary(item) },
      alignments: resolved.map(({ alignment, competency }) => ({ competency, purpose: alignment.purpose, review: { status: "reviewed", ...review } })),
      review: { status: "approved", ...review },
      provenance: {
        // A URL import is the publisher's own page; an upload's publisher is unknown, so it is recorded as the district's.
        source: item.source.kind === "url" ? "official" : "district-authored",
        sourceUri: locatorOf(item),
        retrievedAt: item.submittedAt,
        sourceRevision: item.snapshotDigest,
      },
    });
    if (!descriptor.success) throw new SchoolOsError("validation-failed", "the item cannot be released as a registry resource");
    const release: StudioRelease = {
      descriptor: descriptor.data,
      itemId: item.id,
      scope: item.targetScope,
      alignmentEvidence: resolved.map(({ alignment }) => ({ competencyUri: alignment.competencyUri, evidence: alignment.evidence })),
    };
    await this.#options.storage.addRelease(release);
    item.decision = { outcome: "approved", by: subject.principalId, at, version };
    await this.#transition(item, "approved", subject.principalId, at);
    await this.#transition(item, "released", subject.principalId, at, `version ${version}`);
    await this.#save(item);
    return release;
  }

  /** Rejects a reviewed item. Its snapshot stays in quarantine for the record; nothing is released. */
  async reject(subject: StudioSubject, itemId: unknown, input: unknown): Promise<ContentItem> {
    const { reason } = parseInput(RejectInput, input);
    const item = await this.#item(subject, itemId, "approve");
    if (item.state !== "reviewed") throw new SchoolOsError("conflict", `an item cannot be rejected while ${item.state}`);
    const at = this.#now();
    item.decision = { outcome: "rejected", by: subject.principalId, at, reason };
    await this.#transition(item, "rejected", subject.principalId, at);
    await this.#save(item);
    return item;
  }

  /** Publishes a released item to the district's resource registry, where its scope can discover it. */
  async publish(subject: StudioSubject, itemId: unknown): Promise<ContentItem> {
    const item = await this.#item(subject, itemId, "publish");
    await this.#transition(item, "published", subject.principalId, this.#now());
    await this.#save(item);
    return item;
  }

  /**
   * Releases usable at `scope`: those released for a scope containing it (a district-wide release
   * is usable in every offering) and those released within it.
   */
  async listReleases(subject: StudioSubject, scope: unknown, resourceId?: unknown): Promise<StudioRelease[]> {
    const parsed = parseInput(Scope, scope);
    const resource = resourceId === undefined ? undefined : parseInput(ResourceId, resourceId);
    await this.#require(subject, "list", parsed);
    return (await this.#options.storage.listReleases(resource))
      .filter((release) => scopeContains(release.scope, parsed) || scopeContains(parsed, release.scope));
  }

  /**
   * Binds a release to a class. Only a released resource can be bound, and only to an offering
   * its release scope contains.
   *
   * @throws SchoolOsError `conflict` if the resource has no release yet, `forbidden` if the subject
   *   may not assign in the offering or the release does not cover it, `not-found` otherwise.
   */
  async bindToOffering(subject: StudioSubject, input: unknown): Promise<ClassBinding> {
    const { resourceId, version, offering } = parseInput(BindInput, input);
    const releases = await this.#options.storage.listReleases(resourceId);
    const release = version === undefined ? releases.at(-1) : releases.find((r) => r.descriptor.release.version === version);
    if (release === undefined) {
      const pending = (await this.#options.storage.listItems()).filter((item) => item.resourceId === resourceId && !USABLE_STATES.includes(item.state));
      for (const item of pending) {
        if (await this.#allowed(subject, "read", item.targetScope, item.id)) {
          throw new SchoolOsError("conflict", `the resource is ${item.state}; only a released resource can be used by a class`);
        }
      }
      throw new SchoolOsError("not-found", "no such release");
    }
    await this.#require(subject, "assign", offering);
    if (!scopeContains(release.scope, offering)) throw new SchoolOsError("forbidden", "the release is not approved for this class");
    const binding: ClassBinding = { resourceId, version: release.descriptor.release.version, offering, boundBy: subject.principalId, boundAt: this.#now() };
    await this.#options.storage.addBinding(binding);
    await this.#audit({ itemId: release.itemId, type: "bound", actor: subject.principalId, at: binding.boundAt, detail: `${binding.version} to ${offering.offeringId}` });
    return binding;
  }

  /** Runs an import through quarantine, parsing, provenance and review, auditing each step. */
  async #ingest(
    subject: StudioSubject,
    input: {
      source: ItemSource;
      contentType: ContentType;
      bytes: Uint8Array;
      targetScope: Scope;
      resourceId: ResourceId | undefined;
      previousDigest: string | undefined;
      scan: ContentItem["scan"];
    },
  ): Promise<ContentItem> {
    const digest = await snapshotDigest(input.bytes);
    if (digest === input.previousDigest) throw new SchoolOsError("conflict", "the source has not changed since its latest release");
    const at = this.#now();
    const item: ContentItem = {
      id: ContentItemId.parse(`cit_${randomIdBody()}`),
      districtId: this.#options.districtId,
      resourceId: input.resourceId ?? ResourceId.parse(`rsc_${randomIdBody()}`),
      revision: 0,
      state: "discovered",
      targetScope: input.targetScope,
      submittedBy: subject.principalId,
      submittedAt: at,
      source: input.source,
      contentType: input.contentType,
      snapshotDigest: digest,
      byteLength: input.bytes.byteLength,
      scan: input.scan,
      title: input.source.kind === "upload" ? input.source.fileName : undefined,
      canonicalUrl: undefined,
      lang: undefined,
      license: { status: "absent", hints: [] },
      rights: { proposed: "link", current: "link", changes: [] },
      checks: undefined,
      ai: undefined,
      decision: undefined,
    };
    await this.#audit({ itemId: item.id, type: "transition", actor: subject.principalId, at, to: "discovered" });
    await this.#transition(item, "quarantined", "system", at);
    if (input.scan?.verdict === "infected") {
      // The infected bytes are never stored.
      item.decision = { outcome: "rejected", by: "system", at, reason: "the malware scan found a threat" };
      await this.#transition(item, "rejected", "system", at, "malware-detected");
      await this.#save(item);
      return item;
    }
    await this.#options.storage.putSnapshot(digest, input.bytes);

    let metadata: PageMetadata | undefined;
    let text: string | undefined;
    if (input.contentType === "html" || input.contentType === "text") {
      const decoded = new TextDecoder().decode(input.bytes);
      if (input.contentType === "html") {
        metadata = extractPageMetadata(decoded, input.source.kind === "url" ? input.source.finalUrl : "https://upload.invalid/");
        text = metadata.text;
        item.title = metadata.title ?? item.title;
        item.lang = metadata.lang;
      } else {
        text = decoded;
      }
    }
    await this.#transition(item, "parsed", "system", at);

    item.license = interpretLicenseHints(metadata?.licenseHints ?? []);
    if (input.source.kind === "url" && metadata?.canonicalUrl !== undefined
      && new URL(metadata.canonicalUrl).origin === new URL(input.source.finalUrl).origin) {
      // A page may only name a canonical URL on its own origin, or it could claim another publisher's identity.
      item.canonicalUrl = metadata.canonicalUrl;
    }
    const proposed = proposeRightsMode(item.license);
    item.rights = { proposed, current: proposed, changes: [{ from: undefined, to: proposed, by: "importer", at, widened: false, reason: `proposed from license evidence (${item.license.status})` }] };
    await this.#transition(item, "provenance-resolved", "system", at);

    item.checks = runChecks({ contentType: input.contentType, metadata, text, license: item.license, ageHooks: this.#options.ageHooks ?? [] });
    item.ai = await runAiReview(this.#options.reviewer, { title: item.title, sourceUrl: input.source.kind === "url" ? input.source.finalUrl : undefined, text }, randomIdBody());
    await this.#transition(item, "reviewed", "system", this.#now());
    await this.#save(item);
    return item;
  }

  /** The resource a submission updates, checked to be visible and at the same scope. */
  async #updateTarget(subject: StudioSubject, resourceId: ResourceId | undefined, targetScope: Scope) {
    if (resourceId === undefined) return undefined;
    const latest = (await this.#options.storage.listReleases(resourceId)).at(-1);
    if (latest === undefined || !(await this.#allowed(subject, "read", latest.scope))) throw new SchoolOsError("not-found", "no such resource");
    if (!sameScope(latest.scope, targetScope)) throw new SchoolOsError("validation-failed", "an update must target the scope of the resource's latest release");
    return { resourceId, digest: latest.descriptor.release.contentDigest };
  }

  async #item(subject: StudioSubject, itemId: unknown, action: Action): Promise<ContentItem> {
    const id = ContentItemId.safeParse(itemId);
    if (!id.success) throw NOT_FOUND();
    const item = await this.#options.storage.getItem(id.data);
    if (item === undefined || item.districtId !== this.#options.districtId) throw NOT_FOUND();
    if (!(await this.#allowed(subject, "read", item.targetScope, item.id))) throw NOT_FOUND();
    if (action !== "read") await this.#require(subject, action, item.targetScope, item.id);
    return item;
  }

  async #allowed(subject: StudioSubject, action: Action, scope: Scope, id?: string): Promise<boolean> {
    const decision = await this.#options.authorizer.authorize({
      subject,
      action,
      resource: { kind: "learning-resource", ...(id === undefined ? {} : { id }), scope, classification: "teacher-only" },
      context: { channel: this.#options.channel ?? "http" },
    } satisfies AuthorizationRequest);
    return decision.effect === "allow";
  }

  async #require(subject: StudioSubject, action: Action, scope: Scope, id?: string): Promise<void> {
    if (!(await this.#allowed(subject, action, scope, id))) throw new SchoolOsError("forbidden", `not permitted to ${action} here`);
  }

  async #transition(item: ContentItem, to: PipelineState, actor: StudioAuditEvent["actor"], at: string, detail?: string): Promise<void> {
    assertTransition(item.state, to);
    await this.#audit({ itemId: item.id, type: "transition", actor, at, from: item.state, to, ...(detail === undefined ? {} : { detail }) });
    item.state = to;
  }

  async #audit(event: StudioAuditEvent): Promise<void> {
    await this.#options.storage.appendAudit(event);
  }

  async #save(item: ContentItem): Promise<void> {
    item.revision += 1;
    await this.#options.storage.putItem(item);
  }
}

/** Where a release's resource lives: the canonical or final URL, or the upload's snapshot. */
function locatorOf(item: ContentItem): string {
  if (item.source.kind === "url") return item.canonicalUrl ?? item.source.finalUrl;
  return `urn:schoolos:snapshot:${item.snapshotDigest}`;
}

function accessibilitySummary(item: ContentItem): string | undefined {
  const flags = item.checks?.flags.filter((flag) => flag.code === "lang-missing" || flag.code === "images-without-alt") ?? [];
  return flags.length === 0 ? undefined : flags.map((flag) => flag.message).join(" ");
}
