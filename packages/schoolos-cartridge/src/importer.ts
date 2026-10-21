import {
  ContentItemId,
  type Action,
  type AuthorizationRequest,
  type Authorizer,
  type DistrictId,
  type RequestChannel,
  Scope,
  SchoolOsError,
  type VerifiedPrincipal,
} from "@schoolos/contracts";
import { type ContentItem, type ContentStudio, randomIdBody, snapshotDigest, USABLE_STATES } from "@schoolos/content-studio";
import { CurriculumPack, LearningUnit, type LearningUnitItem } from "@schoolos/registry";
import { z } from "zod";
import { DEFAULT_CARTRIDGE_LIMITS, type CartridgeLimits, readCartridge } from "./package.ts";
import type { CatalogMirror } from "@schoolos/catalog";
import type { ToolRegistrationStore } from "@schoolos/lti";
import { type CartridgeLink, type CartridgeProvenance, type OutlineNode, planCartridgeImport } from "./plan.ts";
import { CartridgeImport, CartridgeImportId, type CartridgeImportStorage } from "./record.ts";
import { type AlignmentSuggestion, suggestCaseAlignments } from "./suggestions.ts";
import { resolveToolLaunch, type ToolLaunchResolution } from "./tools.ts";

/** A package upload's description. The file name is kept for display only. */
export const ImportCartridgeInput = z.strictObject({
  fileName: z.string().trim().min(1).max(255),
  targetScope: Scope,
});
/** A package upload's description. */
export type ImportCartridgeInput = z.infer<typeof ImportCartridgeInput>;

/** Everything a cartridge importer needs. Each district runs its own. */
export interface CartridgeImporterOptions {
  districtId: DistrictId;
  storage: CartridgeImportStorage;
  /** The district's Content Studio, which fetches, reviews and releases each link a teacher submits. */
  studio: ContentStudio;
  /** Decides every call, over the same `learning-resource` rules as the studio. */
  authorizer: Authorizer;
  channel?: RequestChannel;
  limits?: CartridgeLimits;
  /** The district's approved LTI tools. Without it, no imported tool is launchable. */
  toolRegistrations?: ToolRegistrationStore;
  /** The district's catalog mirror, for suggesting alignments. Without it, nothing is suggested. */
  catalog?: CatalogMirror;
  /** The current time as an ISO 8601 timestamp. */
  now?: () => string;
}

/** Why a placement in the outline is not yet in a proposed learning unit. */
export type UnresolvedReason = "not-submitted" | "refused" | "not-released" | "requires-registration";

/**
 * Registry records proposed from an import's hierarchy, built from the links released so far. Each
 * top-level module becomes one learning unit holding, in order, the released resources anywhere
 * beneath it; top-level links outside any module form one more unit. Records are `unreviewed`
 * proposals with fresh identifiers: a curriculum admin reviews and publishes them.
 */
export interface CurriculumProposal {
  units: LearningUnit[];
  /** Undefined until at least one unit has a released resource. */
  pack: CurriculumPack | undefined;
  /** Placements that could not be included, so the gaps are visible rather than silently dropped. */
  unresolved: { identifier: string; kind: "link" | "tool"; reason: UnresolvedReason }[];
}

/** Where a Content Studio item imported from a cartridge came from. */
export interface ItemCartridgeOrigin {
  importId: CartridgeImportId;
  linkId: string;
  provenance: CartridgeProvenance;
}

const NOT_FOUND = () => new SchoolOsError("not-found", "no such cartridge import");

function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new SchoolOsError("validation-failed", `${issue.path.join(".") || "input"}: ${issue.message}`);
}

/**
 * Imports Thin Common Cartridge and Common Cartridge packages (roadmap §5.3, PR C04).
 *
 * A cartridge contributes links and hierarchy only. Its web links are recorded in quarantine and
 * fetched only when a teacher submits one to the Content Studio for review. Its LTI links are
 * recorded as external tool references that can never be launched from an import. Everything else
 * in the package, including any file content, is skipped and counted.
 */
export class CartridgeImporter {
  readonly #options: CartridgeImporterOptions;
  readonly #now: () => string;

  constructor(options: CartridgeImporterOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Reads a package and records what it holds. Nothing it references is fetched.
   *
   * @throws SchoolOsError `forbidden` if the subject may not create resources at the target scope,
   *   and CartridgeRefusedError (`policy-violation`) for an unsafe or malformed package, in which
   *   case nothing is recorded.
   */
  async importPackage(subject: VerifiedPrincipal, input: unknown, bytes: Uint8Array): Promise<CartridgeImport> {
    const { fileName, targetScope } = parseInput(ImportCartridgeInput, input);
    await this.#require(subject, "create", targetScope);
    const plan = planCartridgeImport(await readCartridge(bytes, this.#options.limits ?? DEFAULT_CARTRIDGE_LIMITS));
    const record = CartridgeImport.parse({
      id: `cci_${randomIdBody()}`,
      districtId: this.#options.districtId,
      revision: 1,
      targetScope,
      fileName,
      importedBy: subject.principalId,
      importedAt: this.#now(),
      ...plan,
    });
    await this.#options.storage.putImport(record);
    return record;
  }

  /** An import's record: its links and their review status, tool references, outline and skipped report. */
  async getImport(subject: VerifiedPrincipal, importId: unknown): Promise<CartridgeImport> {
    return this.#import(subject, importId, "read");
  }

  /**
   * Submits one quarantined link to the Content Studio, which fetches it through its SSRF guard and
   * runs its review. This is the only path by which a cartridge link is ever fetched.
   *
   * @throws SchoolOsError `not-found` for an unknown import or link, `policy-violation` for a link
   *   whose URL was refused at import, `conflict` for one already submitted, and whatever
   *   {@link ContentStudio.submitUrl} throws, in which case the link stays quarantined.
   */
  async submitLinkForReview(subject: VerifiedPrincipal, importId: unknown, linkId: unknown): Promise<{ link: CartridgeLink; item: ContentItem }> {
    const record = await this.#import(subject, importId, "read");
    const link = record.links.find((candidate) => candidate.id === linkId);
    if (link === undefined) throw new SchoolOsError("not-found", "no such link in this import");
    if (link.review.status === "refused") throw new SchoolOsError("policy-violation", `the link's URL is refused (${link.review.reason})`);
    if (link.review.status === "submitted") throw new SchoolOsError("conflict", "the link has already been submitted for review");
    const item = await this.#options.studio.submitUrl(
      subject,
      { url: link.url, targetScope: record.targetScope },
      { fileName: record.fileName, packageDigest: record.packageDigest, importId: record.id, linkId: link.id },
    );
    link.review = { status: "submitted", contentItemId: item.id, by: subject.principalId, at: this.#now() };
    record.revision += 1;
    await this.#options.storage.putImport(record);
    return { link, item };
  }

  /** The cartridge a Content Studio item was submitted from, if any, among imports the subject can read. */
  async findItemOrigin(subject: VerifiedPrincipal, contentItemId: unknown): Promise<ItemCartridgeOrigin | undefined> {
    const id = ContentItemId.safeParse(contentItemId);
    if (!id.success) return undefined;
    for (const record of await this.#options.storage.listImports()) {
      const link = record.links.find((candidate) => candidate.review.status === "submitted" && candidate.review.contentItemId === id.data);
      if (link === undefined || record.districtId !== this.#options.districtId) continue;
      if (!(await this.#allowed(subject, "read", record.targetScope, record.id))) return undefined;
      return { importId: record.id, linkId: link.id, provenance: link.provenance };
    }
    return undefined;
  }

  /**
   * Whether each of an import's tools can launch: through the one approved registration covering
   * its launch URL's host, or not at all. Resolved against the registrations as they are now; the
   * import record itself never records a tool as launchable.
   */
  async toolLaunches(subject: VerifiedPrincipal, importId: unknown): Promise<ToolLaunchResolution[]> {
    const record = await this.#import(subject, importId, "read");
    const registrations = (await this.#options.toolRegistrations?.list(this.#options.districtId)) ?? [];
    return record.tools.map((tool) => resolveToolLaunch(tool, registrations));
  }

  /**
   * Catalog items the import's CASE-shaped standards GUIDs may name, for a reviewer to consider.
   * They are never applied: an alignment exists only once a reviewer names it in an approval.
   */
  async suggestAlignments(subject: VerifiedPrincipal, importId: unknown): Promise<AlignmentSuggestion[]> {
    const record = await this.#import(subject, importId, "read");
    return this.#options.catalog === undefined ? [] : suggestCaseAlignments(record.links, this.#options.catalog);
  }

  /**
   * Proposes registry learning units and a curriculum pack from an import's hierarchy, using the
   * releases its submitted links have reached so far. Tools are never included: they have no
   * release; see {@link CartridgeImporter.toolLaunches} for whether one can launch.
   */
  async proposeCurriculum(subject: VerifiedPrincipal, importId: unknown): Promise<CurriculumProposal> {
    const record = await this.#import(subject, importId, "read");
    const at = this.#now();
    const unresolved: CurriculumProposal["unresolved"] = [];
    const links = new Map(record.links.map((link) => [link.id, link]));

    const resolve = async (node: Exclude<OutlineNode, { kind: "module" }>): Promise<LearningUnitItem | undefined> => {
      if (node.kind === "tool") {
        unresolved.push({ identifier: node.identifier, kind: "tool", reason: "requires-registration" });
        return undefined;
      }
      const review = links.get(node.linkId)?.review;
      if (review?.status !== "submitted") {
        unresolved.push({ identifier: node.identifier, kind: "link", reason: review?.status === "refused" ? "refused" : "not-submitted" });
        return undefined;
      }
      const item = await this.#options.studio.getReport(subject, review.contentItemId);
      if (!USABLE_STATES.includes(item.state) || item.decision?.outcome !== "approved") {
        unresolved.push({ identifier: node.identifier, kind: "link", reason: "not-released" });
        return undefined;
      }
      return { kind: "resource", resourceId: item.resourceId, releaseVersion: item.decision.version };
    };
    const flatten = async (nodes: readonly OutlineNode[]): Promise<LearningUnitItem[]> => {
      const items: LearningUnitItem[] = [];
      for (const node of nodes) {
        if (node.kind === "module") items.push(...(await flatten(node.children)));
        else {
          const item = await resolve(node);
          if (item !== undefined) items.push(item);
        }
      }
      return items;
    };

    const packTitle = record.metadata.title ?? record.fileName;
    const groups: { identifier: string; title: string; nodes: OutlineNode[] }[] = [];
    const loose = record.outline.filter((node) => node.kind !== "module");
    if (loose.length > 0) groups.push({ identifier: record.manifestIdentifier || "top-level", title: packTitle, nodes: loose });
    for (const node of record.outline) if (node.kind === "module") groups.push({ identifier: node.identifier, title: node.title, nodes: node.children });

    const units: LearningUnit[] = [];
    for (const group of groups) {
      const items = await flatten(group.nodes);
      if (items.length === 0) continue;
      units.push(LearningUnit.parse({
        id: `unt_${randomIdBody()}`,
        release: { version: "1.0.0", releasedAt: at, contentDigest: await digestOf(items) },
        title: group.title,
        items,
        provenance: provenanceOf(record, group.identifier),
      }));
    }
    const refs = units.map((unit) => ({ unitId: unit.id, releaseVersion: unit.release.version }));
    const pack = units.length === 0 ? undefined : CurriculumPack.parse({
      id: `pck_${randomIdBody()}`,
      release: { version: "1.0.0", releasedAt: at, contentDigest: await digestOf(refs) },
      title: packTitle,
      ...(record.metadata.description === undefined ? {} : { description: record.metadata.description }),
      audience: {},
      units: refs,
      review: { status: "unreviewed" },
      provenance: provenanceOf(record, undefined),
    });
    return { units, pack, unresolved };
  }

  async #import(subject: VerifiedPrincipal, importId: unknown, action: Action): Promise<CartridgeImport> {
    const id = CartridgeImportId.safeParse(importId);
    if (!id.success) throw NOT_FOUND();
    const record = await this.#options.storage.getImport(id.data);
    if (record === undefined || record.districtId !== this.#options.districtId) throw NOT_FOUND();
    if (!(await this.#allowed(subject, "read", record.targetScope, record.id))) throw NOT_FOUND();
    if (action !== "read") await this.#require(subject, action, record.targetScope, record.id);
    return record;
  }

  async #allowed(subject: VerifiedPrincipal, action: Action, scope: Scope, id?: string): Promise<boolean> {
    const decision = await this.#options.authorizer.authorize({
      subject,
      action,
      resource: { kind: "learning-resource", ...(id === undefined ? {} : { id }), scope, classification: "teacher-only" },
      context: { channel: this.#options.channel ?? "http" },
    } satisfies AuthorizationRequest);
    return decision.effect === "allow";
  }

  async #require(subject: VerifiedPrincipal, action: Action, scope: Scope, id?: string): Promise<void> {
    if (!(await this.#allowed(subject, action, scope, id))) throw new SchoolOsError("forbidden", `not permitted to ${action} here`);
  }
}

async function digestOf(value: unknown): Promise<string> {
  return snapshotDigest(new TextEncoder().encode(JSON.stringify(value)));
}

/** Proposed records are derived from the package, so their provenance names it and the item they came from. */
function provenanceOf(record: CartridgeImport, itemIdentifier: string | undefined) {
  const base = `urn:schoolos:cartridge:${record.packageDigest}`;
  return {
    source: "derived",
    sourceUri: itemIdentifier === undefined ? base : `${base}:item:${encodeURIComponent(itemIdentifier)}`,
    retrievedAt: record.importedAt,
    sourceRevision: record.packageDigest,
  };
}
