import { SchoolOsError } from "@schoolos/contracts";
import { matchToolRegistration, type ToolMatchRefusal, type ToolRegistration, type ToolRegistrationId } from "@schoolos/lti";
import type { ExternalToolReference } from "./plan.ts";

/**
 * How an imported tool would launch: entirely through the district's registration. Only the
 * target link and custom parameters come from the cartridge; the client, deployment and login
 * endpoint are the registration's, so a cartridge cannot point a launch anywhere it chooses.
 */
export interface ToolLaunchPlan {
  registrationId: ToolRegistrationId;
  clientId: string;
  deploymentId: string;
  /** Where the launch's OIDC login begins: the registration's endpoint, never the cartridge's. */
  oidcLoginUrl: string;
  /** The cartridge's launch URL, which is on a host the registration covers. */
  targetLinkUri: string;
  /** The cartridge's custom parameters, passed to the tool as data. */
  customParams: Readonly<Record<string, string>>;
}

/** Whether an imported tool can launch, and through which registration. */
export type ToolLaunchResolution =
  | { toolId: string; status: "launchable"; launch: ToolLaunchPlan }
  | { toolId: string; status: "requires-registration"; reason: ToolMatchRefusal };

/**
 * Matches an imported tool against the district's registrations by its launch URL's host. A tool
 * matched by exactly one approved registration launches only through it; any other tool stays
 * unlaunchable. The stored reference never changes: it remains `launchable: false`, and the match
 * is made again, against current registrations, every time.
 */
export function resolveToolLaunch(tool: ExternalToolReference, registrations: readonly ToolRegistration[]): ToolLaunchResolution {
  const match = matchToolRegistration(registrations, tool.launchUrl);
  if (!match.ok) return { toolId: tool.id, status: "requires-registration", reason: match.reason };
  const { registration } = match;
  return {
    toolId: tool.id,
    status: "launchable",
    launch: {
      registrationId: registration.id,
      clientId: registration.clientId,
      deploymentId: registration.deploymentId,
      oidcLoginUrl: registration.oidcLoginUrl,
      targetLinkUri: tool.launchUrl,
      customParams: tool.customParams,
    },
  };
}

/**
 * The launch plan for an imported tool, through the one approved registration covering its host.
 *
 * @throws SchoolOsError `forbidden` when no approved registration covers it (or more than one
 *   does): an import never grants launch rights by itself.
 */
export function assertToolLaunchable(tool: ExternalToolReference, registrations: readonly ToolRegistration[] = []): ToolLaunchPlan {
  const resolution = resolveToolLaunch(tool, registrations);
  if (resolution.status === "launchable") return resolution.launch;
  throw new SchoolOsError("forbidden", `${tool.domain} has no approved LTI registration (${resolution.reason}); imported tools cannot be launched`);
}
