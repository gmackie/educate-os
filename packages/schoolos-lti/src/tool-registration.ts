import { DistrictId, PrincipalId, SchoolOsError } from "@schoolos/contracts";
import { z } from "zod";

const LtiId = z.string().min(1).max(255);
const HttpsUrl = z.url({ protocol: /^https$/ });

/** A host name as a launch URL carries it: lowercase, no port, no trailing dot. */
const HostName = z
  .string()
  .max(253)
  .regex(/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "expected a lowercase host name such as sim.tools.example");

/**
 * Identifies a tool registration. It follows the `<prefix>_<body>` convention of
 * `@schoolos/contracts`, and may belong there once another package needs it.
 */
export const ToolRegistrationId = z.string().regex(/^ltr_[a-z0-9][a-z0-9-]{0,62}$/, "expected a tool registration ID (ltr_…)").brand<"toolRegistration">();
/** A tool registration identifier. */
export type ToolRegistrationId = z.infer<typeof ToolRegistrationId>;

/**
 * An external LTI 1.3 tool a district approved for launch from SchoolOS, which acts as the
 * platform. It is the only way an imported tool reference can ever launch: a cartridge names a tool
 * by its launch URL's host, and only a registration covering that host, approved by a named
 * person, makes it launchable, through this registration's own endpoints and client.
 *
 * The other direction, an LMS launching into SchoolOS, is a `PlatformRegistration`.
 */
export const ToolRegistration = z.strictObject({
  id: ToolRegistrationId,
  districtId: DistrictId,
  name: z.string().trim().min(1).max(200),
  /** The exact hosts the tool launches on. A host matches only itself, never its subdomains. */
  domains: z.array(HostName).min(1).max(20),
  /** The client ID SchoolOS issued the tool. */
  clientId: LtiId,
  /** The deployment the tool is launched through. */
  deploymentId: LtiId,
  /** The tool's OIDC login initiation endpoint, where a launch begins. */
  oidcLoginUrl: HttpsUrl,
  /** The tool's JWKS, which signs its deep-linking responses and service requests. */
  jwksUrl: HttpsUrl,
  /** Only an approved registration launches anything; a suspended one keeps its record. */
  status: z.enum(["approved", "suspended"]),
  approvedBy: PrincipalId,
  approvedAt: z.iso.datetime({ offset: true }),
});
/** A tool registration. */
export type ToolRegistration = z.infer<typeof ToolRegistration>;

/** Where a district's tool registrations are read from. */
export interface ToolRegistrationStore {
  /** Every registration the district holds, approved or not. */
  list(districtId: DistrictId): Promise<readonly ToolRegistration[]>;
}

/** An in-memory {@link ToolRegistrationStore}. */
export class InMemoryToolRegistrationStore implements ToolRegistrationStore {
  readonly #registrations: ToolRegistration[];

  /**
   * Validates every registration.
   *
   * @throws SchoolOsError `conflict` if two share an ID.
   */
  constructor(registrations: readonly unknown[]) {
    this.#registrations = registrations.map((registration) => ToolRegistration.parse(registration));
    if (new Set(this.#registrations.map((r) => r.id)).size !== this.#registrations.length) {
      throw new SchoolOsError("conflict", "Two tool registrations share an ID.");
    }
  }

  async list(districtId: DistrictId): Promise<readonly ToolRegistration[]> {
    return this.#registrations.filter((registration) => registration.districtId === districtId);
  }
}

/** Why no registration launches a tool on some host. */
export type ToolMatchRefusal = "no-registration" | "ambiguous" | "insecure-launch-url";

/**
 * The approved registration that launches a tool whose launch URL is `launchUrl`: the one whose
 * `domains` include the URL's host exactly. The URL must be `https` on the default port. Two
 * approved registrations covering the same host decide nothing, since either could be the tool.
 */
export function matchToolRegistration(
  registrations: readonly ToolRegistration[],
  launchUrl: string,
): { ok: true; registration: ToolRegistration } | { ok: false; reason: ToolMatchRefusal } {
  if (!URL.canParse(launchUrl)) return { ok: false, reason: "insecure-launch-url" };
  const url = new URL(launchUrl);
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return { ok: false, reason: "insecure-launch-url" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const matches = registrations.filter((registration) => registration.status === "approved" && registration.domains.includes(host));
  if (matches.length === 0) return { ok: false, reason: "no-registration" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, registration: matches[0]! };
}
