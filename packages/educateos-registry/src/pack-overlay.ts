// Organisation and content-policy overlays for curriculum packs (roadmap §5.2, C01b, SCHO-42). An
// overlay is a district, school, offering or activity's local adjustment to one pack: units it
// hides, the order it teaches them in, units it keeps at another release, and the content policy
// its resources must meet. Overlays sit beside pack releases and are applied when a pack is read,
// so a release is never changed and is always recoverable as published.
import {
  CurriculumPackId,
  LearningUnitId,
  PrincipalId,
  SCOPE_LEVELS,
  EducateOsError,
  Scope,
  scopeContains,
} from "@educateos/contracts";
import { z } from "zod";
import { type CurriculumPack, LearningUnitRef } from "./curriculum.ts";
import { type ResourceDescriptor, ResourceKind, RightsMode } from "./resource.ts";

/**
 * What the resources a pack uses must meet in a scope. Every rule only narrows: a narrower scope
 * can add rules but never relax one a wider scope set (ADR-0004's policy floors), so there is no
 * way to write "not required". The rules use Content Studio's vocabulary (C03): rights modes,
 * license verification, review status, resource kinds and schema.org accessibility hazards.
 */
export const ContentPolicy = z.strictObject({
  /** The rights modes a resource may be used under; one of its permitted uses must be listed. */
  allowedRightsModes: z.array(RightsMode).min(1).optional(),
  /** Only resources whose license a named person verified. */
  requireVerifiedLicense: z.literal(true).optional(),
  /** Only resources whose review was approved. */
  requireApprovedReview: z.literal(true).optional(),
  blockedResourceKinds: z.array(ResourceKind).min(1).optional(),
  /** schema.org `accessibilityHazard` terms, such as `flashing`, that exclude a resource. */
  blockedHazards: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
});
/** A content policy. */
export type ContentPolicy = z.infer<typeof ContentPolicy>;

const unique = (ids: readonly string[]) => new Set(ids).size === ids.length;

/** One scope's overlay on one curriculum pack. */
export const PackOverlay = z
  .strictObject({
    packId: CurriculumPackId,
    scope: Scope,
    /** Units not shown in this scope. A narrower scope cannot show a unit a wider one hid. */
    hide: z.array(LearningUnitId).min(1).max(500).optional(),
    /** Units taught first, in this order; the rest follow in the order they had. */
    order: z.array(LearningUnitId).min(1).max(500).optional(),
    /** Units kept at another release than the pack names, such as one a school's materials match. */
    pin: z.array(LearningUnitRef).min(1).max(500).optional(),
    contentPolicy: ContentPolicy.optional(),
    note: z.string().max(2000).optional(),
    author: PrincipalId,
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .refine((o) => unique(o.hide ?? []) && unique(o.order ?? []) && unique((o.pin ?? []).map((p) => p.unitId)), {
    message: "a unit appears at most once in each of hide, order and pin",
  });
/** A pack overlay. */
export type PackOverlay = z.infer<typeof PackOverlay>;

/** An overlay entry that names a unit the pack release does not contain, and so changed nothing. */
export interface IgnoredOverlayEntry {
  scope: Scope;
  field: "hide" | "order" | "pin";
  unitId: LearningUnitId;
}

/** A pack as one scope sees it: its release with every applicable overlay applied. */
export interface EffectivePack {
  packId: CurriculumPackId;
  /** The pack release the view was built from, unchanged. */
  releaseVersion: string;
  scope: Scope;
  /** The units shown, in teaching order, each at its effective release. */
  units: LearningUnitRef[];
  /** The units hidden in this scope, in pack order. */
  hidden: LearningUnitId[];
  /** Every applicable overlay's content policy, combined; empty when none applies. */
  contentPolicy: ContentPolicy;
  /** The scopes whose overlays applied, widest first. */
  appliedScopes: Scope[];
  ignored: IgnoredOverlayEntry[];
}

const scopeKey = (scope: Scope) =>
  [scope.level, scope.districtId, "schoolId" in scope ? scope.schoolId : "", "offeringId" in scope ? scope.offeringId : "",
    "activityId" in scope ? scope.activityId : ""].join("/");

const intersect = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined): T[] | undefined =>
  a === undefined ? b && [...b] : b === undefined ? [...a] : a.filter((x) => b.includes(x));

const union = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined): T[] | undefined =>
  a === undefined && b === undefined ? undefined : [...new Set([...(a ?? []), ...(b ?? [])])];

/**
 * Combines two content policies so the result is at least as strict as each: allowed rights modes
 * intersect, requirements accumulate, and blocked kinds and hazards accumulate. An intersection
 * that leaves no rights mode allows no resource at all.
 */
export function narrowContentPolicy(wider: ContentPolicy, narrower: ContentPolicy): ContentPolicy {
  const combined = {
    allowedRightsModes: intersect(wider.allowedRightsModes, narrower.allowedRightsModes),
    requireVerifiedLicense: wider.requireVerifiedLicense ?? narrower.requireVerifiedLicense,
    requireApprovedReview: wider.requireApprovedReview ?? narrower.requireApprovedReview,
    blockedResourceKinds: union(wider.blockedResourceKinds, narrower.blockedResourceKinds),
    blockedHazards: union(wider.blockedHazards, narrower.blockedHazards),
  };
  return Object.fromEntries(Object.entries(combined).filter(([, v]) => v !== undefined)) as ContentPolicy;
}

/**
 * The pack as `scope` sees it. Applies, widest first, every overlay on this pack whose scope
 * contains `scope` (overlays from other districts never apply): hidden units accumulate, each
 * `order` re-sequences what the wider scopes left, the narrowest pin of a unit wins, and content
 * policies narrow. Neither the pack nor the overlays are modified.
 *
 * @throws EducateOsError `validation-failed` if an overlay or the scope is malformed, or `conflict`
 *   if two applicable overlays share a scope, so which applies would be ambiguous.
 */
export function applyPackOverlays(pack: CurriculumPack, overlays: readonly unknown[], scope: Scope): EffectivePack {
  const target = Scope.safeParse(scope);
  if (!target.success) throw new EducateOsError("validation-failed", "not a scope");
  const parsed = overlays.map((overlay) => {
    const result = PackOverlay.safeParse(overlay);
    if (!result.success) throw new EducateOsError("validation-failed", "not a pack overlay");
    return result.data;
  });
  const applicable = parsed
    .filter((o) => o.packId === pack.id && scopeContains(o.scope, target.data))
    .toSorted((a, b) => SCOPE_LEVELS.indexOf(a.scope.level) - SCOPE_LEVELS.indexOf(b.scope.level));
  const seen = new Set<string>();
  for (const overlay of applicable) {
    const key = scopeKey(overlay.scope);
    if (seen.has(key)) throw new EducateOsError("conflict", `two overlays on ${pack.id} share the scope ${key}`);
    seen.add(key);
  }

  const inPack = new Set<string>(pack.units.map((u) => u.unitId));
  const ignored: IgnoredOverlayEntry[] = [];
  const known = (overlay: PackOverlay, field: IgnoredOverlayEntry["field"], unitId: LearningUnitId) => {
    if (inPack.has(unitId)) return true;
    ignored.push({ scope: overlay.scope, field, unitId });
    return false;
  };

  let sequence = pack.units.map((u) => u.unitId);
  const hidden = new Set<string>();
  const versions = new Map(pack.units.map((u) => [u.unitId as string, u.releaseVersion]));
  let contentPolicy: ContentPolicy = {};
  for (const overlay of applicable) {
    for (const unitId of overlay.hide ?? []) if (known(overlay, "hide", unitId)) hidden.add(unitId);
    if (overlay.order !== undefined) {
      const first = overlay.order.filter((unitId) => known(overlay, "order", unitId));
      sequence = [...first, ...sequence.filter((unitId) => !first.includes(unitId))];
    }
    for (const ref of overlay.pin ?? []) if (known(overlay, "pin", ref.unitId)) versions.set(ref.unitId, ref.releaseVersion);
    if (overlay.contentPolicy !== undefined) contentPolicy = narrowContentPolicy(contentPolicy, overlay.contentPolicy);
  }

  return {
    packId: pack.id,
    releaseVersion: pack.release.version,
    scope: target.data,
    units: sequence.filter((unitId) => !hidden.has(unitId)).map((unitId) => ({ unitId, releaseVersion: versions.get(unitId)! })),
    hidden: pack.units.map((u) => u.unitId).filter((unitId) => hidden.has(unitId)),
    contentPolicy,
    appliedScopes: applicable.map((o) => o.scope),
    ignored,
  };
}

/** Why a content policy excludes a resource. */
export type ContentPolicyViolation =
  | "rights-mode-not-allowed"
  | "license-unverified"
  | "review-not-approved"
  | "kind-blocked"
  | "hazard-blocked";

/** Every rule of `policy` the resource breaks; empty when the policy admits it. */
export function contentPolicyViolations(policy: ContentPolicy, resource: ResourceDescriptor): ContentPolicyViolation[] {
  const violations: ContentPolicyViolation[] = [];
  if (policy.allowedRightsModes !== undefined && !resource.license.permittedUses.some((use) => policy.allowedRightsModes!.includes(use))) {
    violations.push("rights-mode-not-allowed");
  }
  if (policy.requireVerifiedLicense && resource.license.verification.status !== "verified") violations.push("license-unverified");
  if (policy.requireApprovedReview && resource.review.status !== "approved") violations.push("review-not-approved");
  if (policy.blockedResourceKinds?.includes(resource.kind)) violations.push("kind-blocked");
  if (resource.accessibility.hazards.some((hazard) => policy.blockedHazards?.includes(hazard))) violations.push("hazard-blocked");
  return violations;
}
