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

/** The error body every admin route answers with. */
export interface AdminErrorBody {
  code: string;
  message: string;
}
