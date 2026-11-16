// EducateOS as an LTI 1.3 Platform (SCHO-179, IF-10): the Assignment and Grade Services 2.0 a hosted
// tool calls, from the platform's side. This module holds the parts with no state: the schemas of
// the line items, scores and results the tool sends and receives, the scopes a deployment's
// services grant, and the launch's AGS endpoint claim. The district keeps line items and results in
// its Durable Object, and every score waits for a teacher's approval before it counts
// (`@educateos/lti-district`'s `LtiPlatformAgsService`). See docs/educateos/lti.md.
import { z } from "zod";
import { DistrictId, OfferingId, UtcTimestamp } from "@educateos/contracts";
import { PLATFORM_SCOPE_SERVICES } from "./platform-service-tokens.ts";
import { PlatformDeploymentId, PlatformToolId, type PlatformDeployment } from "./platform-tools.ts";
import { AGS_SCOPES, type LtiScope } from "./service-client.ts";
import { randomToken } from "./stores.ts";

/** The AGS endpoint claim of a launch (AGS 2.0 §3.1). */
export const PLATFORM_AGS_ENDPOINT_CLAIM = "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint";

/** A line item's ID, the last segment of its URL: `lli_` and 22 random characters. */
export const PlatformLineItemId = z.string().regex(/^lli_[A-Za-z0-9_-]{22}$/, "expected a platform line item ID (lli_…)");
/** A platform line item ID. */
export type PlatformLineItemId = z.infer<typeof PlatformLineItemId>;

/** A new line item ID. */
export const newPlatformLineItemId = (): PlatformLineItemId => `lli_${randomToken().slice(0, 22)}`;

const Text = z.string().trim().min(1).max(255);

/**
 * A line item as a tool creates or replaces it (AGS 2.0 §3.2): a gradebook column of the offering.
 * Members other than these, its `id` among them, are dropped: the platform assigns the ID and keeps
 * no extension a tool sends.
 */
export const PlatformLineItemInput = z.object({
  label: Text,
  scoreMaximum: z.number().finite().positive().max(1_000_000),
  /** The resource link the column belongs to: a launch's `resource_link.id`. */
  resourceLinkId: Text.optional(),
  /** The tool's own identifier for what is graded. */
  resourceId: Text.optional(),
  tag: Text.optional(),
  startDateTime: z.iso.datetime({ offset: true }).optional(),
  endDateTime: z.iso.datetime({ offset: true }).optional(),
});
/** A line item a tool sends. */
export type PlatformLineItemInput = z.infer<typeof PlatformLineItemInput>;

/**
 * A stored line item: a tool's gradebook column in one offering, reached only through the one
 * deployment it was created through. `revision` counts its changes, so a score queued against one
 * revision is not approved against another.
 */
export const PlatformLineItem = z.strictObject({
  id: PlatformLineItemId,
  districtId: DistrictId,
  toolId: PlatformToolId,
  deploymentId: PlatformDeploymentId,
  offeringId: OfferingId,
  label: Text,
  scoreMaximum: z.number().finite().positive(),
  resourceLinkId: Text.optional(),
  resourceId: Text.optional(),
  tag: Text.optional(),
  startDateTime: z.iso.datetime({ offset: true }).optional(),
  endDateTime: z.iso.datetime({ offset: true }).optional(),
  revision: z.int().positive(),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
});
/** A stored line item. */
export type PlatformLineItem = z.infer<typeof PlatformLineItem>;

/** How far a learner got with the activity (AGS 2.0 §3.4.4). */
export const ActivityProgress = z.enum(["Initialized", "Started", "InProgress", "Submitted", "Completed"]);
/** How far the tool got with grading it (AGS 2.0 §3.4.5). */
export const GradingProgress = z.enum(["FullyGraded", "Pending", "PendingManual", "Failed", "NotReady"]);

/**
 * A score a tool posts for one learner (AGS 2.0 §3.4). `userId` is the learner's subject for this
 * tool. A `scoreGiven` needs a `scoreMaximum`, and neither may be negative.
 */
export const PlatformScore = z.object({
  userId: z.string().min(1).max(255),
  scoreGiven: z.number().finite().min(0).max(1_000_000).optional(),
  scoreMaximum: z.number().finite().positive().max(1_000_000).optional(),
  comment: z.string().max(1000).optional(),
  activityProgress: ActivityProgress,
  gradingProgress: GradingProgress,
  timestamp: z.iso.datetime({ offset: true }),
}).refine((score) => score.scoreGiven === undefined || score.scoreMaximum !== undefined, "A scoreGiven needs a scoreMaximum.");
/** A score. */
export type PlatformScore = z.infer<typeof PlatformScore>;

/**
 * The AGS scopes `deployment` grants: the line items service gives line item management and result
 * reads, and the scores service gives score posts (`PLATFORM_SCOPE_SERVICES`).
 */
export function platformAgsScopes(deployment: PlatformDeployment): LtiScope[] {
  return AGS_SCOPES.filter((scope) => deployment.services[PLATFORM_SCOPE_SERVICES[scope]]);
}

/**
 * A launch's AGS endpoint claim, or nothing when the deployment uses no AGS service: the scopes it
 * grants, the line items container of exactly that deployment and offering when it may manage line
 * items, and the resource link's own line item when there is one.
 */
export function platformAgsEndpointClaim(
  deployment: PlatformDeployment,
  urls: { lineItems: string; lineItem?: string | undefined },
): Record<string, unknown> {
  const scope = platformAgsScopes(deployment);
  if (scope.length === 0) return {};
  return {
    [PLATFORM_AGS_ENDPOINT_CLAIM]: {
      scope,
      ...deployment.services.agsLineItems ? { lineitems: urls.lineItems } : {},
      ...urls.lineItem === undefined ? {} : { lineitem: urls.lineItem },
    },
  };
}

/** A line item as the platform answers with it (AGS 2.0 §3.2), at its URL. */
export function lineItemBody(item: PlatformLineItem, url: string): Record<string, unknown> {
  return {
    id: url,
    label: item.label,
    scoreMaximum: item.scoreMaximum,
    ...item.resourceLinkId === undefined ? {} : { resourceLinkId: item.resourceLinkId },
    ...item.resourceId === undefined ? {} : { resourceId: item.resourceId },
    ...item.tag === undefined ? {} : { tag: item.tag },
    ...item.startDateTime === undefined ? {} : { startDateTime: item.startDateTime },
    ...item.endDateTime === undefined ? {} : { endDateTime: item.endDateTime },
  };
}
