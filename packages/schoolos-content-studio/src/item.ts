import type { ContentItemId, DistrictId, PrincipalId, ResourceId, Scope } from "@schoolos/contracts";
import type { ResourceDescriptor, RightsMode } from "@schoolos/registry";
import type { LicenseEvidence } from "./license.ts";
import type { PipelineState } from "./pipeline.ts";
import type { AiReview, CheckFlagCode, ChecksReport } from "./review.ts";
import type { ScanOutcome } from "./scanner.ts";
import type { ContentType } from "./sniff.ts";

/** Where an item's content came from. */
export type ItemSource =
  | { kind: "url"; submittedUrl: string; finalUrl: string; hops: string[] }
  | { kind: "upload"; fileName: string };

/** One change to an item's rights mode. Every change is kept, including the importer's proposal. */
export interface RightsChange {
  from: RightsMode | undefined;
  to: RightsMode;
  by: PrincipalId | "importer";
  at: string;
  /** Whether the change widened the mode, which only a curriculum admin may do. */
  widened: boolean;
  reason: string;
}

/** An item's rights: the importer's proposal, the current mode, and how it got there. */
export interface ItemRights {
  proposed: RightsMode;
  current: RightsMode;
  changes: RightsChange[];
}

/** A reviewer's decision on an item. */
export type ItemDecision =
  | {
    outcome: "approved";
    by: PrincipalId;
    at: string;
    version: string;
    /**
     * The blocking flags the approver explicitly acknowledged: every one the item had. Absent on
     * decisions recorded before acknowledgement was required.
     */
    acknowledgedFlags?: CheckFlagCode[];
  }
  | { outcome: "rejected"; by: PrincipalId | "system"; at: string; reason: string };

/** One imported revision of a source, as it moves through the pipeline. */
export interface ContentItem {
  id: ContentItemId;
  districtId: DistrictId;
  /** The registry resource this item becomes a release of. A source update reuses it. */
  resourceId: ResourceId;
  /** Incremented on every write; storage refuses a write based on a stale read. */
  revision: number;
  state: PipelineState;
  /** Where the resource is meant to be used: one offering, a school, or the whole district. */
  targetScope: Scope;
  submittedBy: PrincipalId;
  submittedAt: string;
  source: ItemSource;
  contentType: ContentType;
  /** The `sha256:` digest of the raw bytes, as retrieved. The bytes themselves stay in quarantine storage. */
  snapshotDigest: string;
  byteLength: number;
  /** Set for uploads. URL imports are not scanned: they are fetched, not executed, and never served as files. */
  scan: ScanOutcome | undefined;
  title: string | undefined;
  canonicalUrl: string | undefined;
  lang: string | undefined;
  license: LicenseEvidence;
  rights: ItemRights;
  checks: ChecksReport | undefined;
  ai: AiReview | undefined;
  decision: ItemDecision | undefined;
}

/** The evidence a reviewer gave for one alignment. Kept beside the release, which has no field for it. */
export interface AlignmentEvidence {
  competencyUri: string;
  evidence: string;
}

/**
 * One immutable release of a resource. A source update adds a new release; earlier releases stay
 * as they were, so classes using them keep working (roadmap §14).
 */
export interface StudioRelease {
  descriptor: ResourceDescriptor;
  itemId: ContentItemId;
  /** Where the release may be bound: the scope its approver had authority over. */
  scope: Scope;
  alignmentEvidence: AlignmentEvidence[];
}

/** A release bound to a class. */
export interface ClassBinding {
  resourceId: ResourceId;
  version: string;
  offering: Extract<Scope, { level: "offering" }>;
  boundBy: PrincipalId;
  boundAt: string;
}
