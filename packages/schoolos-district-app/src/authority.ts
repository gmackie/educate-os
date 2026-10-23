// Which system owns a district's directory, as a deployment states it (SCHO-186). A roster district
// lets OneRoster own every record type; a district with no roster, such as a homeschool co-op,
// keeps its own records in SchoolOS and builds its classes by hand.
import { z } from "zod";
import { AuthorityMap } from "@schoolos/contracts";

/** The OneRoster roster owns every directory record type. The default. */
export const ONEROSTER_AUTHORITY: AuthorityMap = {
  school: "external:oneroster",
  term: "external:oneroster",
  course: "external:oneroster",
  offering: "external:oneroster",
  enrollment: "external:oneroster",
  principal: "external:oneroster",
};

/**
 * SchoolOS owns every directory record type: administrators create schools, terms, courses,
 * offerings and principals, and enroll students, through the admin API. For a district with no
 * roster to sync from, such as a homeschool co-op. A roster import into such a district is refused
 * for every record type, because none is the roster's to write.
 */
export const LOCAL_AUTHORITY: AuthorityMap = {
  school: "local",
  term: "local",
  course: "local",
  offering: "local",
  enrollment: "local",
  principal: "local",
};

/** A named authority map: `oneroster` ({@link ONEROSTER_AUTHORITY}) or `local` ({@link LOCAL_AUTHORITY}). */
export const AuthorityProfile = z.enum(["oneroster", "local"]);
/** An authority profile name. */
export type AuthorityProfile = z.infer<typeof AuthorityProfile>;

/** What a deployment may configure: a profile by name, or an authority map in full for a mixed district. */
export const AuthoritySetting = z.union([AuthorityProfile, AuthorityMap]);
/** An authority setting. */
export type AuthoritySetting = z.infer<typeof AuthoritySetting>;

/** The authority map a setting names. With none, the roster owns everything. */
export function authorityFor(setting: AuthoritySetting | undefined): AuthorityMap {
  if (setting === undefined || setting === "oneroster") return ONEROSTER_AUTHORITY;
  if (setting === "local") return LOCAL_AUTHORITY;
  return AuthorityMap.parse(setting);
}
