import { CapabilityId } from "@schoolos/contracts";
import { CommercialAccountId, ContactRole, InstanceId } from "@schoolos/fleet";
import { z } from "zod";
import { ReleasePin } from "./manifest.ts";

const DnsLabel = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, "expected a DNS label");
const DomainName = z
  .string()
  .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "expected a lowercase domain name")
  .max(253);

/**
 * The longest instance slug (the instance ID after `ins_`). Every resource name is
 * `schoolos-<slug>-<suffix>`, and the longest suffix (`gatekeeper-mcp-portal`) must still fit
 * Cloudflare's 63-character Worker name limit.
 */
export const MAX_INSTANCE_SLUG_LENGTH = 20;

/**
 * What a district supplies to install SchoolOS into its own Cloudflare account. Nothing here is a
 * secret: credentials come from the token provider and gatekeeper secrets from a
 * {@link SecretSource}.
 */
export const DistrictInstallConfig = z.strictObject({
  /** The instance ID the district registered with the root, or chose for a district-run install. */
  instanceId: InstanceId.refine(
    (id) => id.length - "ins_".length <= MAX_INSTANCE_SLUG_LENGTH,
    `instance ID slug must be at most ${MAX_INSTANCE_SLUG_LENGTH} characters`,
  ),
  /** The district's Cloudflare account ID. */
  accountId: z.string().regex(/^[0-9a-f]{32}$/, "expected a Cloudflare account ID"),
  /** The district-owned zone SchoolOS is served under, e.g. `northfield.example`. */
  baseDomain: DomainName,
  /** The label under {@link DistrictInstallConfig.baseDomain} SchoolOS is served on. */
  subdomain: DnsLabel.default("schoolos"),
  access: z.strictObject({
    /** The Zero Trust team name, i.e. `<team>.cloudflareaccess.com`. */
    teamName: DnsLabel,
    /** Email domains whose verified users the Access policy admits, e.g. `northfield.example`. */
    allowedEmailDomains: z.array(DomainName).min(1).max(20),
  }),
  /**
   * Break-glass administrator emails, written to the backend's `ADMINS` var. They live only in
   * the district's own account.
   */
  admins: z.array(z.email()).min(1).max(20),
  release: ReleasePin,
  /** Gatekeepers to install besides the release's preinstalled ones, by package name. */
  gatekeepers: z.array(z.string().regex(/^gatekeeper-[a-z0-9-]+$/)).max(32).default([]),
  /** Creates an AI Gateway named after the instance and points the backend at it. */
  aiGateway: z.boolean().default(false),
  /**
   * What the installer tells the root's registry after a successful apply. Absent for a
   * district-run install that does not register with the root.
   */
  fleet: z.strictObject({
    districtLabel: z.string().min(1).max(120),
    commercialAccountId: CommercialAccountId,
    contactRole: ContactRole,
    capabilityIds: z.array(CapabilityId).max(64),
  }).optional(),
});
/** A district install config, as parsed (defaults applied). */
export type DistrictInstallConfig = z.infer<typeof DistrictInstallConfig>;

/** The instance slug every resource name carries: the instance ID without its `ins_` prefix. */
export function instanceSlug(config: Pick<DistrictInstallConfig, "instanceId">): string {
  return config.instanceId.slice("ins_".length);
}

/**
 * The name prefix that marks a resource as this instance's. The installer treats the prefix as a
 * reserved namespace in the district's account: it adopts storage resources carrying it, and it
 * never touches a resource without it.
 */
export function resourcePrefix(config: Pick<DistrictInstallConfig, "instanceId">): string {
  return `schoolos-${instanceSlug(config)}`;
}

/** The hostname SchoolOS is served on. */
export function publicHostname(config: Pick<DistrictInstallConfig, "subdomain" | "baseDomain">): string {
  return `${config.subdomain}.${config.baseDomain}`;
}

/** The Cloudflare Worker name of one release package for this instance. */
export function workerScriptName(config: Pick<DistrictInstallConfig, "instanceId">, pkgName: string): string {
  return `${resourcePrefix(config)}-${pkgName}`;
}

/**
 * Supplies `$SECRET(<name>)` values, per worker package. Values are passed straight to the
 * Cloudflare secrets API and never logged or returned in a plan.
 */
export interface SecretSource {
  /** The value for one worker's secret, or undefined if the operator has not supplied it. */
  get(pkgName: string, secretName: string): string | undefined;
}

/** A {@link SecretSource} over a fixed map, keyed `<pkgName>/<SECRET_NAME>`. For tests and the harness. */
export function staticSecretSource(values: Record<string, string>): SecretSource {
  return { get: (pkgName, secretName) => values[`${pkgName}/${secretName}`] };
}
