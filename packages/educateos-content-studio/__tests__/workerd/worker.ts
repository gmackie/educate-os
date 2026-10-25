// Test worker for the workerd suite: Northfield's Content Studio Durable Object, hosting the studio
// over `DurableObjectContentStudioStorage` the way a deployed district Worker would, so calls arrive
// as separate requests to one object and survive its restarts.

import { DurableObject } from "cloudflare:workers";
import { InMemoryAcademicStore } from "@educateos/academics";
import { DistrictDirectorySnapshot, DistrictId, PrincipalId, EducateOsError, type ContentItemId, type PolicySettings, type ResourceId } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { directoryPolicyInformation, InMemoryPolicyAuditSink, PolicyEngine } from "@educateos/policy";
import { ContentStudio, type ContentItem, type StudioAuditEvent, type StudioRelease } from "../../src/index.ts";
import { DurableObjectContentStudioStorage } from "../../src/durable-object-store.ts";

/** Northfield's ID. */
export const NF = DistrictId.parse("dst_northfield");
/** Biology, fall period 2, which Morgan Lee teaches. */
export const BIO = { level: "offering", districtId: NF, schoolId: "sch_nf-high", offeringId: "off_nf-bio-fall-p2" } as const;

/** A call's outcome, with a refusal's code carried across RPC rather than its error. */
export type Result<T> = { ok: true; value: T } | { ok: false; code: string };

async function attempt<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof EducateOsError) return { ok: false, code: error.code };
    throw error;
  }
}

/** The policy floor the suite decides under: the conservative district defaults. */
const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "private",
  teacherObservation: "assigned-work-only",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};

/** The district's policy engine over Northfield's directory, as the studio decides with it. */
const engine = () => new PolicyEngine({
  information: directoryPolicyInformation(InMemoryAcademicStore.seeded(DistrictDirectorySnapshot.parse(NORTHFIELD)), { effectivePolicy: async () => FLOOR }),
  audit: new InMemoryPolicyAuditSink(),
});

const caller = (principalId: string) => ({ principalId: PrincipalId.parse(principalId), districtId: NF });

/** Northfield's Content Studio. */
export class TestStudio extends DurableObject {
  readonly #storage: DurableObjectContentStudioStorage;
  readonly #studio: ContentStudio;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#storage = new DurableObjectContentStudioStorage(ctx.storage);
    this.#studio = new ContentStudio({
      districtId: NF,
      storage: this.#storage,
      authorizer: engine(),
      fetch: async () => new Response(null, { status: 404 }),
      scanner: "none",
      alignments: { resolve: async () => undefined },
    });
  }

  /** Uploads `text` as a plain-text resource for Biology. */
  async upload(principalId: string, fileName: string, text: string, updatesResourceId?: ResourceId): Promise<Result<ContentItem>> {
    return attempt(() => this.#studio.submitUpload(
      caller(principalId),
      { fileName, mediaType: "text/plain", targetScope: BIO, ...(updatesResourceId === undefined ? {} : { updatesResourceId }) },
      new TextEncoder().encode(text),
    ));
  }

  /** Approves an item with no alignments. */
  async approve(principalId: string, itemId: ContentItemId): Promise<Result<StudioRelease>> {
    return attempt(() => this.#studio.approve(caller(principalId), itemId, { alignments: [] }));
  }

  /** Binds the latest release of a resource to Biology. */
  async bind(principalId: string, resourceId: ResourceId): Promise<Result<unknown>> {
    return attempt(() => this.#studio.bindToOffering(caller(principalId), { resourceId, offering: BIO }));
  }

  /** Every stored item. */
  async items(): Promise<ContentItem[]> {
    return this.#storage.listItems();
  }

  /** Every release. */
  async releases(): Promise<StudioRelease[]> {
    return this.#storage.listReleases();
  }

  /** An item's audit trail. */
  async audit(itemId: ContentItemId): Promise<StudioAuditEvent[]> {
    return this.#storage.listAudit(itemId);
  }

  /** A quarantined snapshot. */
  async snapshot(digest: string): Promise<Uint8Array | undefined> {
    return this.#storage.getSnapshot(digest);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
