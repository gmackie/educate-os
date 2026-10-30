// The admin's own HTTP API (SCHO-263): what the Worker serves under /api and the SPA reads. The
// district's bodies (`@educateos/fleet/ops`) pass through inside these unchanged.
import type { OpsAnalyticsResponse, OpsScope } from "@educateos/fleet/ops";
import { z } from "zod";

/** Which admin this is: admin.educateos.io, or the open-source admin in a district's own account. */
export const Edition = z.enum(["hosted", "oss"]);
/** An admin edition. */
export type Edition = z.infer<typeof Edition>;

/** An operator's role: an admin may act, a viewer may only look. */
export const OperatorRole = z.enum(["admin", "viewer"]);
/** An operator role. */
export type OperatorRole = z.infer<typeof OperatorRole>;

/** `GET /api/me`. */
export interface Me {
  operator: { email: string; role: OperatorRole };
  edition: Edition;
  /** In the OSS edition, the only origins workspaces may be enrolled from. */
  allowedOrigins?: string[];
  /** In the hosted edition, educateos.io's guided install, which makes a new workspace. */
  installUrl?: string;
}

/** Where a workspace's enrollment stands. */
export type WorkspaceStatus = "pending" | "active" | "removed";

/** A workspace (district) this admin manages. */
export interface Workspace {
  id: string;
  slug: string;
  displayName: string;
  origin: string;
  edition: Edition;
  enrolledAt: string;
  status: WorkspaceStatus;
}

/** `GET /api/workspaces/:id`. */
export interface WorkspaceDetail extends Workspace {
  /** The admin's current signing key for this workspace, as the district registers it. */
  key?: { keyId: string; publicKey: string; createdAt: string };
}

/** A workspace slug: what the district is called in URLs (`northfield`). */
export const Slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "lowercase letters, digits and hyphens");

/** `POST /api/workspaces`: enroll a district. */
export const EnrollmentRequest = z.strictObject({
  slug: Slug,
  displayName: z.string().trim().min(1).max(120),
  /** The district's origin, `https://<host>`, with no path. */
  origin: z.string().min(1).max(300),
  edition: Edition.optional(),
});
/** An enrollment request. */
export type EnrollmentRequest = z.infer<typeof EnrollmentRequest>;

/** What the district registers to let this admin in. */
export interface OpsRegistration {
  /** Where the requests come from, for the district's records. */
  adminOrigin: string;
  keyId: string;
  publicKey: string;
  /** The scopes this admin asks for. The district may grant fewer. */
  scopes: OpsScope[];
}

/** `POST /api/workspaces`. */
export interface EnrollmentResponse {
  workspace: WorkspaceDetail;
  registration: OpsRegistration;
  /** The steps for the district's administrator, in order. */
  instructions: string[];
}

/** `GET /api/workspaces/:id/analytics`. */
export interface AnalyticsEnvelope {
  analytics: OpsAnalyticsResponse;
  fetchedAt: string;
  /** Served from this admin's snapshot rather than fetched now. */
  cached: boolean;
  /** The district could not be reached, so an older snapshot is shown. */
  stale: boolean;
}

/** One audit entry. */
export interface AuditEntry {
  id: number;
  at: string;
  operatorSub: string;
  operatorEmail?: string;
  workspaceId?: string;
  action: string;
  target?: string;
  result: string;
}

/** `GET /api/audit`. */
export interface AuditPage {
  entries: AuditEntry[];
  nextCursor?: string;
}

/** An installation made through educateos.io's guided install (hosted edition, SCHO-263). */
export interface InstallationRecord {
  instanceId: string;
  /** The workspace it maps onto. Absent when another workspace already had its slug or origin. */
  workspaceId?: string;
  slug: string;
  /** The managed hostname it serves at, `<slug>.educateos.io`. */
  hostname: string;
  /** Who installed it: their email, when they are a known operator. */
  installedBy?: string;
  cloudflareAccountId: string;
  releaseVersion: string;
  installedAt: string;
  importedAt: string;
}

/** A slug the guided install holds, as last imported from educateos.io. */
export interface SlugReservationRecord {
  slug: string;
  instanceId: string;
  reservedBy?: string;
  cloudflareAccountId: string;
  /** Set while an install run holds it. */
  leaseUntil?: string;
}

/** `GET /api/installations`. */
export interface InstallationsResponse {
  installations: InstallationRecord[];
  reservations: SlugReservationRecord[];
}

/** `POST /api/import/control-plane`. */
export const ImportRequest = z.strictObject({
  /** Report what the import would do, and write nothing. */
  dryRun: z.boolean().optional(),
});
/** An import request. */
export type ImportRequest = z.infer<typeof ImportRequest>;

/** How many rows an import created, changed or left alone. */
export interface ImportCounts {
  created: number;
  updated: number;
  unchanged: number;
}

/** What an import of educateos.io's operators, installations and reservations did, or would do. */
export interface ImportReport {
  dryRun: boolean;
  /** When educateos.io took the snapshot. */
  exportedAt: string;
  operators: ImportCounts;
  /** Workspaces made for installations, and installations matched to a workspace already here. */
  workspaces: { created: number; matched: number };
  installations: ImportCounts;
  reservations: ImportCounts & { removed: number };
  /** Installations that couldn't map onto a workspace, and why. */
  skipped: { instanceId: string; slug: string; reason: "slug-taken" | "origin-taken" }[];
}

/** The error body every admin route answers with. */
export interface AdminErrorBody {
  code: string;
  message: string;
}
