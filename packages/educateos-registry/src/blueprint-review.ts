import { z } from "zod";
import {
  CapabilityId, Principal, RoleAssignment, Scope, SemVer, ResourceId,
  roleAssignmentInForce, scopeContains,
} from "@educateos/contracts";
import { CompetencyRef, ImmutableRelease } from "./primitives.ts";

const digest = ImmutableRelease.shape.contentDigest;

/** Education metadata attached to the exact Blueprint artifact being reviewed. */
export const BlueprintEducationMetadata = z.strictObject({
  id: ResourceId,
  version: SemVer,
  artifactDigest: digest,
  scope: Scope,
  author: Principal.pick({ id: true, kind: true }),
  instructionalIntent: z.enum(["teach", "practice", "assess", "explore", "create"]),
  gradeBand: z.enum(["pk", "k-2", "3-5", "6-8", "9-12", "postsecondary"]),
  standards: z.array(CompetencyRef).max(100),
  requiredCapabilities: z.array(CapabilityId).max(100),
  license: z.enum(["CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "MIT", "Apache-2.0"]),
  provenance: z.strictObject({
    source: z.enum(["original", "derived"]),
    sourceDigest: digest,
  }),
  accessibility: z.strictObject({
    features: z.array(z.enum(["keyboard", "screen-reader", "captions", "text-alternatives", "reduced-motion"])),
    hazards: z.array(z.enum(["flashing", "sound", "motion"])),
    evidenceDigest: digest,
  }),
  evaluation: z.strictObject({
    evidenceDigest: digest,
    outcome: z.enum(["passed", "failed", "not-evaluated"]),
  }),
});
/** Validated education metadata, with no embedded Gadget data or credential configuration. */
export type BlueprintEducationMetadata = z.infer<typeof BlueprintEducationMetadata>;

/** The publication lifecycle for one immutable Blueprint version. */
export type BlueprintReviewState = "draft" | "submitted" | "reviewed" | "approved" | "rejected" | "revoked";

/** Trusted server-resolved identity and assignments; never accept these from a publisher. */
export interface BlueprintReviewActor {
  principal: Principal;
  assignments: RoleAssignment[];
}

/** A review decision pinned to an artifact version. Internal identities are not exported. */
export interface BlueprintReviewEvent {
  requestId: string;
  actorId: Principal["id"];
  action: Exclude<BlueprintReviewState, "draft">;
  at: string;
}

/** Detached snapshot for audit and administrative review. */
export interface BlueprintReviewSnapshot {
  metadata: BlueprintEducationMetadata;
  state: BlueprintReviewState;
  history: BlueprintReviewEvent[];
}

/**
 * Domain SDK for version-pinned review. The host must serialize commands and durably store its
 * snapshots before acknowledging requests. This class provides no authentication or persistence.
 * Public export is deliberately a closed projection: no free-form text, URLs, source code,
 * user identities, resource bindings, credentials, or learner/evaluation payloads.
 */
export class BlueprintReviewCatalog {
  #records = new Map<string, BlueprintReviewSnapshot>();
  #key(id: string, version: string): string { return JSON.stringify([id, version]); }

  #actor(actor: BlueprintReviewActor, scope: Scope): BlueprintReviewActor {
    const parsed = { principal: Principal.parse(actor.principal), assignments: z.array(RoleAssignment).parse(actor.assignments) };
    if (parsed.principal.status !== "active" || parsed.principal.districtId !== scope.districtId) {
      throw new Error("Inactive or cross-district actor");
    }
    return parsed;
  }

  /** Create an immutable version in draft. A changed artifact requires a different version. */
  create(input: unknown, actor: BlueprintReviewActor): BlueprintReviewSnapshot {
    const metadata = BlueprintEducationMetadata.parse(input);
    const trusted = this.#actor(actor, metadata.scope);
    if (trusted.principal.id !== metadata.author.id || trusted.principal.kind !== metadata.author.kind) {
      throw new Error("Only the author may create a draft");
    }
    const key = this.#key(metadata.id, metadata.version);
    const existing = this.#records.get(key);
    if (existing) {
      if (JSON.stringify(existing.metadata) !== JSON.stringify(metadata)) throw new Error("Version is immutable");
      return structuredClone(existing);
    }
    // A resource identity cannot move to another author or district in a later version.
    for (const record of this.#records.values()) {
      if (record.metadata.id === metadata.id && (record.metadata.author.id !== metadata.author.id
        || JSON.stringify(record.metadata.scope) !== JSON.stringify(metadata.scope))) throw new Error("Resource ownership is immutable");
    }
    const record: BlueprintReviewSnapshot = { metadata, state: "draft", history: [] };
    this.#records.set(key, record);
    return structuredClone(record);
  }

  /** Apply an authorized transition. Repeating an identical request is a no-op. */
  transition(id: string, version: string, action: BlueprintReviewEvent["action"], requestId: string,
    actor: BlueprintReviewActor, at: Date): BlueprintReviewSnapshot {
    z.string().min(1).max(200).parse(requestId);
    const record = this.#records.get(this.#key(id, version));
    if (!record) throw new Error("Unknown Blueprint version");
    const trusted = this.#actor(actor, record.metadata.scope);
    if (!Number.isFinite(at.getTime())) throw new Error("Invalid review time");
    const isReviewer = trusted.principal.kind === "staff" && trusted.principal.id !== record.metadata.author.id
      && trusted.assignments.some((assignment) => assignment.principalId === trusted.principal.id
        && ["teacher", "district-admin", "curriculum-admin"].includes(assignment.role)
        && roleAssignmentInForce(assignment, at) && scopeContains(assignment.scope, record.metadata.scope));
    if (action === "submitted" ? trusted.principal.id !== record.metadata.author.id : !isReviewer) {
      throw new Error("Publication review denied");
    }
    const prior = record.history.find((event) => event.requestId === requestId);
    if (prior) {
      if (prior.action !== action || prior.actorId !== trusted.principal.id) throw new Error("Idempotency conflict");
      return structuredClone(record);
    }
    const allowed: Record<BlueprintReviewState, readonly string[]> = {
      draft: ["submitted"], submitted: ["reviewed", "rejected"], reviewed: ["approved", "rejected"],
      approved: ["revoked"], rejected: [], revoked: [],
    };
    if (!allowed[record.state].includes(action)) throw new Error("Invalid review transition");
    if (record.history.some((event) => Date.parse(event.at) > at.getTime())) throw new Error("Review time moved backwards");
    if (action === "approved" && record.metadata.evaluation.outcome !== "passed") throw new Error("Evaluation must pass");
    record.state = action;
    record.history.push({ requestId, action, actorId: trusted.principal.id, at: at.toISOString() });
    return structuredClone(record);
  }

  /** Export currently approved versions for an open marketplace; revocation removes eligibility. */
  exportEntries() {
    return [...this.#records.values()].filter((record) => record.state === "approved").map(({ metadata }) => ({
      schemaVersion: 1 as const,
      id: metadata.id, version: metadata.version, artifactDigest: metadata.artifactDigest,
      instructionalIntent: metadata.instructionalIntent, gradeBand: metadata.gradeBand,
      // Standard URLs, author/district IDs and internal evidence stay in the review record.
      license: metadata.license,
      requiredCapabilities: [...metadata.requiredCapabilities],
      provenance: structuredClone(metadata.provenance),
      accessibility: structuredClone(metadata.accessibility),
      evaluation: structuredClone(metadata.evaluation),
    }));
  }
}
