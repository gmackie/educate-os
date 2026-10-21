import { z } from "zod";
import { PrincipalId, SchoolOsError } from "@schoolos/contracts";
import type { AcademicStore, Caller } from "@schoolos/academics";
import type { PolicyDecider } from "@schoolos/policy";
import { SubjectRef } from "./archive.ts";
import { DistrictLabel } from "./consent.ts";

/**
 * The portable learner identity, kept deliberately minimal: a destination admin's confirmation
 * that the learner an archive calls `sourcePseudonym`, from the district labelled
 * `sourceInstanceLabel`, is `destinationPrincipalId` here.
 *
 * It is a record for routing imports, never a credential. Nothing signs in with it, and it grants
 * nothing on its own: the learner signs in through the destination's own identity provider, and
 * every write it leads to is still decided by the destination's policy engine. SchoolOS has no
 * global child identity broker (roadmap §12 defers one), so there is no identifier both districts
 * could share; the pseudonym is local to one export, and the link is made by a person who can
 * check, at the destination, who the learner is.
 */
export const PortableIdentityLink = z.strictObject({
  sourceInstanceLabel: DistrictLabel,
  sourcePseudonym: SubjectRef,
  destinationPrincipalId: PrincipalId,
  /** The destination admin who confirmed the link. */
  confirmedBy: PrincipalId,
});
/** A portable identity link. */
export type PortableIdentityLink = z.infer<typeof PortableIdentityLink>;

/** Where a destination district keeps its confirmed identity links. */
export interface PortableIdentityLinkStore {
  /** The link for a source learner pseudonym, if one was confirmed. */
  find(sourceInstanceLabel: string, sourcePseudonym: SubjectRef): Promise<PortableIdentityLink | undefined>;
  /** Stores a link. It rejects with `conflict` if the pseudonym is already linked to someone else. */
  put(link: PortableIdentityLink): Promise<void>;
}

/** A {@link PortableIdentityLinkStore} held in memory, for tests and the local harness. */
export class InMemoryPortableIdentityLinkStore implements PortableIdentityLinkStore {
  readonly #links = new Map<string, PortableIdentityLink>();

  async find(sourceInstanceLabel: string, sourcePseudonym: SubjectRef): Promise<PortableIdentityLink | undefined> {
    const link = this.#links.get(JSON.stringify([sourceInstanceLabel, sourcePseudonym]));
    return link === undefined ? undefined : structuredClone(link);
  }

  async put(link: PortableIdentityLink): Promise<void> {
    const key = JSON.stringify([link.sourceInstanceLabel, link.sourcePseudonym]);
    const existing = this.#links.get(key);
    if (existing !== undefined && existing.destinationPrincipalId !== link.destinationPrincipalId) {
      throw new SchoolOsError("conflict", "This learner is already linked to someone else.");
    }
    this.#links.set(key, structuredClone(link));
  }
}

/**
 * Confirms a portable identity link as a destination admin. The admin must be allowed to configure
 * the district (`configure` on its `capability-config`), and the linked principal must be a
 * student of the admin's district.
 */
export async function confirmIdentityLink(
  services: { policy: PolicyDecider; links: PortableIdentityLinkStore; directory: AcademicStore },
  admin: Caller,
  link: Omit<PortableIdentityLink, "confirmedBy">,
): Promise<PortableIdentityLink> {
  const confirmed = PortableIdentityLink.parse({ ...link, confirmedBy: admin.principal.principalId });
  const { decision } = await services.policy.decide({
    subject: admin.principal,
    action: "configure",
    resource: { kind: "capability-config", scope: { level: "district", districtId: admin.principal.districtId }, classification: "district-internal" },
    context: { channel: admin.channel },
  });
  if (decision.effect !== "allow") throw new SchoolOsError("forbidden", "Only a district administrator can link a transferring learner.");
  const { snapshot } = await services.directory.load();
  const learner = snapshot.principals.find((p) => p.id === confirmed.destinationPrincipalId);
  if (learner?.kind !== "student" || learner.districtId !== admin.principal.districtId) throw new SchoolOsError("not-found", "That learner is not in this district.");
  await services.links.put(confirmed);
  return confirmed;
}
