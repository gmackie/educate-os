// The typed bodies of the district's `/api/ops/*` routes (SCHO-263). Both sides parse with these:
// the district before it answers, the admin edition before it shows or caches anything. Objects are
// strict, so a field neither side knows about (and that nobody has checked for personal data) is
// refused rather than passed along.
//
// Analytics and health are aggregates only, and are what an admin edition may cache. Directory and
// device bodies carry personal data: an admin edition passes them through to the operator's browser
// and never stores them.
import { EducateOsErrorBody, PrincipalId } from "@educateos/contracts";
import { z } from "zod";

const Count = z.number().int().nonnegative();
const Bytes = z.number().int().nonnegative();
const Milliseconds = z.number().nonnegative();
/** US dollars in billionths, as the AI guard ledger keeps them (ADR-0008). */
const UsdNanos = z.number().int().nonnegative();
const Timestamp = z.iso.datetime({ offset: true });
const Cursor = z.string().regex(/^[A-Za-z0-9_.~-]{1,256}$/);
/** A release version, such as `1.4.0` or `r000042`. */
const Version = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/);
/** A short label from a fixed vocabulary on the district side (a Worker or binding name). */
const Label = z.string().min(1).max(128);

/** The error body every ops route answers with on failure. */
export const OpsErrorBody = EducateOsErrorBody;
/** An ops error body. */
export type OpsErrorBody = z.infer<typeof OpsErrorBody>;

// ---------------------------------------------------------------------------------------------
// GET /api/ops/health

/** One part of the district the health check looked at. */
export const HealthComponent = z.strictObject({
  name: Label,
  status: z.enum(["ok", "degraded", "down"]),
  /** A short, fixed description of what is wrong. Never quotes stored data. */
  detail: z.string().max(200).optional(),
});

/** `GET /api/ops/health`. */
export const OpsHealthResponse = z.strictObject({
  status: z.enum(["ok", "degraded", "down"]),
  releaseVersion: Version,
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  checkedAt: Timestamp,
  components: z.array(HealthComponent).max(50),
});
/** A health report. */
export type OpsHealthResponse = z.infer<typeof OpsHealthResponse>;

// ---------------------------------------------------------------------------------------------
// GET /api/ops/analytics?range=24h|7d|30d

/** The windows analytics are reported over. */
export const AnalyticsRange = z.enum(["24h", "7d", "30d"]);
/** An analytics window. */
export type AnalyticsRange = z.infer<typeof AnalyticsRange>;

/** `GET /api/ops/analytics`'s query. */
export const OpsAnalyticsQuery = z.strictObject({ range: AnalyticsRange });

/** One Worker's invocations (`workersInvocationsAdaptive`). */
export const WorkerAnalytics = z.strictObject({
  script: Label,
  invocations: Count,
  errors: Count,
  cpuTimeP50Ms: Milliseconds,
  cpuTimeP99Ms: Milliseconds,
});

/** One point of the request and error series the sparklines draw. */
export const AnalyticsPoint = z.strictObject({
  at: Timestamp,
  requests: Count,
  errors: Count,
});

/** `GET /api/ops/analytics`: aggregates for the workspace's Workers, storage, AI and sign-ins. */
export const OpsAnalyticsResponse = z.strictObject({
  range: AnalyticsRange,
  generatedAt: Timestamp,
  /**
   * True when any figure comes from Cloudflare's sampled (adaptive) datasets, so the admin labels
   * the numbers as estimates.
   */
  sampled: z.boolean(),
  workers: z.array(WorkerAnalytics).max(100),
  http: z.strictObject({
    requests: Count,
    /** Requests by HTTP status code (`httpRequestsAdaptiveGroups`). */
    byStatus: z.array(z.strictObject({ status: z.number().int().min(100).max(599), requests: Count })).max(100),
    p95LatencyMs: Milliseconds.optional(),
  }),
  series: z.array(AnalyticsPoint).max(744),
  durableObjects: z.strictObject({ requests: Count, storageBytes: Bytes }),
  storage: z.strictObject({ r2Bytes: Bytes, d1Bytes: Bytes }),
  ai: z.strictObject({
    requests: Count,
    tokensIn: Count,
    tokensOut: Count,
    cacheHits: Count,
    /** Cost as AI Gateway reports it. */
    gatewayCostUsdNanos: UsdNanos,
    /** Cost as the district's AI guard ledger records it: authoritative for budgets. */
    ledgerCostUsdNanos: UsdNanos,
    /** This month's AI budget, when one is set. */
    monthlyBudgetUsdNanos: UsdNanos.optional(),
    monthToDateUsdNanos: UsdNanos,
  }),
  signIns: z.strictObject({
    byMethod: z.array(z.strictObject({ method: z.enum(["google", "clever", "classlink", "pin", "email", "other"]), count: Count })).max(10),
    failures: Count,
  }),
});
/** An analytics report. */
export type OpsAnalyticsResponse = z.infer<typeof OpsAnalyticsResponse>;

// ---------------------------------------------------------------------------------------------
// GET /api/ops/directory, GET /api/ops/directory/:principal, POST .../:action

/** The roles the directory filters and edits by. */
export const DirectoryRole = z.enum(["student", "staff", "guardian", "admin"]);
/** A directory role. */
export type DirectoryRole = z.infer<typeof DirectoryRole>;

/** Where a person's account stands. */
export const DirectoryStatus = z.enum(["active", "suspended", "never-signed-in"]);
/** A directory status. */
export type DirectoryStatus = z.infer<typeof DirectoryStatus>;

/** How a person signs in. */
export const SignInMethod = z.enum(["google", "clever", "classlink", "pin", "email"]);

/** How much AI a person may use. */
export const AiAccessLevel = z.enum(["none", "standard", "extended"]);
/** An AI access level. */
export type AiAccessLevel = z.infer<typeof AiAccessLevel>;

/** `GET /api/ops/directory`'s query. Every field is optional; `query` matches name or email. */
export const OpsDirectoryQuery = z.strictObject({
  query: z.string().min(1).max(200).optional(),
  role: DirectoryRole.optional(),
  status: DirectoryStatus.optional(),
  cursor: Cursor.optional(),
});
/** A directory query. */
export type OpsDirectoryQuery = z.infer<typeof OpsDirectoryQuery>;

/** One person in the directory. Personal data: passed through, never stored by an admin edition. */
export const DirectoryEntry = z.strictObject({
  principal: PrincipalId,
  displayName: z.string().min(1).max(200),
  email: z.email().max(320).optional(),
  roles: z.array(DirectoryRole).max(4),
  schools: z.array(z.string().min(1).max(200)).max(50),
  status: DirectoryStatus,
  signInMethods: z.array(SignInMethod).max(5),
  lastSignInAt: Timestamp.optional(),
  /** Rostered from Clever or OneRoster: only status and role overrides may change here. */
  rostered: z.boolean(),
  aiAccess: AiAccessLevel,
});
/** A directory entry. */
export type DirectoryEntry = z.infer<typeof DirectoryEntry>;

/** `GET /api/ops/directory`. */
export const OpsDirectoryPage = z.strictObject({
  entries: z.array(DirectoryEntry).max(200),
  nextCursor: Cursor.optional(),
});
/** A page of the directory. */
export type OpsDirectoryPage = z.infer<typeof OpsDirectoryPage>;

/** `GET /api/ops/directory/:principal`: the entry plus what the detail drawer shows. */
export const OpsDirectoryDetail = z.strictObject({
  entry: DirectoryEntry,
  /** Linked sign-ins: the issuer and how it is shown, never the raw subject. */
  identities: z.array(z.strictObject({ method: SignInMethod, issuer: z.string().max(200) })).max(20),
  deviceCount: Count,
  aiUsageThisMonthUsdNanos: UsdNanos,
});
/** A directory detail. */
export type OpsDirectoryDetail = z.infer<typeof OpsDirectoryDetail>;

/** The bodies of the directory actions, by action. */
export const DirectoryActionBodies = {
  "suspend": z.strictObject({ reason: z.string().max(500).optional() }),
  "restore": z.strictObject({}),
  "sign-out-everywhere": z.strictObject({}),
  "roles": z.strictObject({
    grant: z.array(z.enum(["staff", "admin"])).max(2),
    revoke: z.array(z.enum(["staff", "admin"])).max(2),
  }),
  "ai-access": z.strictObject({ level: AiAccessLevel }),
} as const;

/** What a directory or device command did. */
export const OpsActionResult = z.strictObject({
  /** False when the command changed nothing (already suspended, say). */
  applied: z.boolean(),
  /** The district's own audit entry for the command. */
  auditId: z.string().min(1).max(128),
});
/** An action result. */
export type OpsActionResult = z.infer<typeof OpsActionResult>;

// ---------------------------------------------------------------------------------------------
// GET /api/ops/devices, POST /api/ops/devices/:id/revoke, POST /api/ops/devices/revoke-below-version

/** `GET /api/ops/devices`'s query. */
export const OpsDevicesQuery = z.strictObject({
  principal: PrincipalId.optional(),
  status: z.enum(["active", "revoked"]).optional(),
  cursor: Cursor.optional(),
});
/** A devices query. */
export type OpsDevicesQuery = z.infer<typeof OpsDevicesQuery>;

/** A device ID: opaque. */
export const OpsDeviceId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** One registered device. Personal data: passed through, never stored by an admin edition. */
export const DeviceEntry = z.strictObject({
  id: OpsDeviceId,
  principal: PrincipalId,
  ownerName: z.string().min(1).max(200),
  ownerRole: DirectoryRole,
  label: z.string().min(1).max(200),
  platform: z.enum(["ios", "android"]),
  model: z.string().max(200).optional(),
  appVersion: Version,
  registeredAt: Timestamp,
  lastSeenAt: Timestamp.optional(),
  lastCountry: z.string().regex(/^[A-Z]{2}$/).optional(),
  push: z.boolean(),
  status: z.enum(["active", "revoked"]),
});
/** A device. */
export type DeviceEntry = z.infer<typeof DeviceEntry>;

/** `GET /api/ops/devices`. */
export const OpsDevicesPage = z.strictObject({
  devices: z.array(DeviceEntry).max(200),
  nextCursor: Cursor.optional(),
});
/** A page of devices. */
export type OpsDevicesPage = z.infer<typeof OpsDevicesPage>;

/** `POST /api/ops/devices/:id/revoke`. */
export const OpsRevokeDeviceBody = z.strictObject({ reason: z.string().max(500).optional() });

/** `POST /api/ops/devices/revoke-below-version`: a forced update. */
export const OpsRevokeBelowVersionBody = z.strictObject({
  minimumVersion: z.string().regex(/^\d+\.\d+\.\d+$/, "expected major.minor.patch"),
  platform: z.enum(["ios", "android"]).optional(),
});
/** A forced update. */
export type OpsRevokeBelowVersionBody = z.infer<typeof OpsRevokeBelowVersionBody>;

/** What a forced update revoked. */
export const OpsRevokeBelowVersionResult = z.strictObject({ revoked: Count, auditId: z.string().min(1).max(128) });

// ---------------------------------------------------------------------------------------------
// GET /api/ops/releases

/** `GET /api/ops/releases`. */
export const OpsReleasesResponse = z.strictObject({
  current: z.strictObject({ version: Version, installedAt: Timestamp.optional() }),
  channel: z.enum(["stable", "beta"]),
  available: z.array(z.strictObject({
    version: Version,
    publishedAt: Timestamp,
    /** A link to the release notes. */
    notesUrl: z.url({ protocol: /^https$/ }).optional(),
  })).max(50),
});
/** A releases report. */
export type OpsReleasesResponse = z.infer<typeof OpsReleasesResponse>;

/** The response schema for each route, so a client can parse whatever it asked for. */
export const OPS_RESPONSES = {
  "health": OpsHealthResponse,
  "analytics": OpsAnalyticsResponse,
  "directory.list": OpsDirectoryPage,
  "directory.get": OpsDirectoryDetail,
  "directory.action": OpsActionResult,
  "devices.list": OpsDevicesPage,
  "devices.revoke": OpsActionResult,
  "devices.revoke-below-version": OpsRevokeBelowVersionResult,
  "releases": OpsReleasesResponse,
} as const;
