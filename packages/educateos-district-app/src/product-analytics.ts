// Product analytics (SCHO-350): whether the district's pages may send usage events to the
// self-hosted analytics service (Dataflare, DATFLR-7) its deployment names.
//
// Two things must both hold before a browser loads anything:
//
// 1. The deployment names a service: the Worker var `PRODUCT_ANALYTICS`, a JSON
//    `ProductAnalyticsDeployment` (host and project). Only deployments we configure carry it; a
//    district's administrator cannot point its pages anywhere else.
// 2. A district administrator turned it on (`District.productAnalytics`), a policy-decided and
//    audited `update` on the district (`AcademicDirectory.setProductAnalytics`). Absent, it is off.
//
// Signed-in people learn the outcome from `GET /api/me/product-analytics`, never from the public
// school manifest: the phone app validates the manifest strictly, and an unsigned visitor has no
// business knowing. The browser module that acts on it (`@educateos/shell`) adds the rest: Do Not
// Track and Global Privacy Control, and the student-safe collection mode.
import { z } from "zod";
import { PrincipalId, UtcTimestamp, type District } from "@educateos/contracts";

/** The analytics service a deployment names: an https origin, and the project its events go to. */
export const ProductAnalyticsDeployment = z.strictObject({
  /** The service's origin, such as `https://analytics.example.org`. No path. */
  host: z.url({ protocol: /^https$/ }).max(2048).refine((text) => new URL(text).origin === text, "expected an origin, such as https://analytics.example.org"),
  /** The service's project for this district. */
  project: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "expected a project id such as educateos-district"),
});
/** The analytics service a deployment names. */
export type ProductAnalyticsDeployment = z.infer<typeof ProductAnalyticsDeployment>;

/**
 * Parses `PRODUCT_ANALYTICS`. Unset or empty, the deployment names no service. The error names
 * invalid fields only, never the value.
 */
export function readProductAnalyticsDeployment(text: string | undefined): ProductAnalyticsDeployment | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("PRODUCT_ANALYTICS is not JSON");
  }
  const parsed = ProductAnalyticsDeployment.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"))].slice(0, 10);
    throw new Error(`PRODUCT_ANALYTICS is invalid at: ${fields.join(", ")}`);
  }
  return parsed.data;
}

/** Product analytics as a district administrator sees it. */
export const ProductAnalyticsAdminBody = z.strictObject({
  /** Whether this deployment names an analytics service. Without one it cannot be turned on. */
  configured: z.boolean(),
  /** Whether an administrator turned it on. */
  enabled: z.boolean(),
  /** When it was last turned on or off, or `null` if never. */
  changedAt: UtcTimestamp.nullable(),
  /** Who last turned it on or off, or `null` if no one has. */
  changedBy: PrincipalId.nullable(),
});
/** Product analytics as a district administrator sees it. */
export type ProductAnalyticsAdminBody = z.infer<typeof ProductAnalyticsAdminBody>;

/**
 * What a signed-in person's pages may do: nothing, or send events to this host and project. On
 * only when the deployment names a service and an administrator turned it on.
 */
export const ProductAnalyticsClientBody = z.discriminatedUnion("enabled", [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({ enabled: z.literal(true), host: ProductAnalyticsDeployment.shape.host, project: ProductAnalyticsDeployment.shape.project }),
]);
/** What a signed-in person's pages may do. */
export type ProductAnalyticsClientBody = z.infer<typeof ProductAnalyticsClientBody>;

/** The administrator's view of a district's product analytics. */
export function productAnalyticsForAdmin(district: District, deployment: ProductAnalyticsDeployment | undefined): ProductAnalyticsAdminBody {
  const setting = district.productAnalytics;
  return {
    configured: deployment !== undefined,
    enabled: setting?.enabled ?? false,
    changedAt: setting?.changedAt ?? null,
    changedBy: setting?.changedBy ?? null,
  };
}

/** What a signed-in person's pages may do: on only when both the deployment and an administrator say so. */
export function productAnalyticsForClient(district: District, deployment: ProductAnalyticsDeployment | undefined): ProductAnalyticsClientBody {
  if (deployment === undefined || district.productAnalytics?.enabled !== true) return { enabled: false };
  return { enabled: true, host: deployment.host, project: deployment.project };
}
