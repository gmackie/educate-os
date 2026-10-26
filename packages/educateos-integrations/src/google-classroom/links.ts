// Linking a district's Classroom courses to the offerings another roster source made, for a
// district whose roster comes from an SIS or Clever and whose classes are taught in Classroom.
// Nothing here creates a principal or an offering: it proposes which Classroom course is which
// offering, and which Google account is which principal, for an administrator to confirm. New for
// SCHO-77.
import { DistrictDirectorySnapshot, EducateOsError, Principal, checkDirectoryIntegrity, externalIdentityKey } from "@educateos/contracts";
import type { GradeAuthority, OfferingId, PrincipalId } from "@educateos/contracts";
import { CLASSROOM_ISSUER, ClassroomGradeRoute } from "@educateos/lti";
import type { ClassroomCourse, ClassroomMember, GoogleClassroomClient } from "./client.ts";

/** A Classroom course matched to an offering, and why. */
export interface ClassroomCourseLink {
  courseId: string;
  offeringId: OfferingId;
  /**
   * `alias`: the course carries an alias naming the offering, as a district's provisioning sets
   * it; safe to accept as proposed. `name-and-section`: the course's name and section equal the
   * offering's course title and section name; an administrator should check it.
   */
  basis: "alias" | "name-and-section";
}

/** A Google account matched to a principal enrolled in a linked course, and why. */
export interface ClassroomIdentityLink {
  principalId: PrincipalId;
  /** The Google user ID, the subject under `https://accounts.google.com`. */
  subject: string;
  /** The course whose roster the match was made in. */
  courseId: string;
  /**
   * `email`: the Workspace email equals the principal's. `name`: only the display name does, and
   * the account's email is on another domain than the principal's, so it cannot contradict the
   * match. A name match is a guess an administrator must confirm one by one: applying one needs
   * `acceptNameMatches`.
   */
  basis: "email" | "name";
}

/** Something the plan could not decide, for an administrator to resolve by hand. */
export interface ClassroomUnresolved {
  courseId: string;
  /** The Google user ID, for a roster member. */
  userId?: string;
  reason:
    | "no-matching-offering"
    | "ambiguous-offering"
    | "no-matching-principal"
    | "ambiguous-principal"
    | "principal-linked-elsewhere"
    | "account-linked-elsewhere"
    | "inconsistent-match"
    | "email-mismatch"
    | "unreadable-record";
  message: string;
}

/** What linking would do. Applying it changes nothing until an administrator accepts parts of it. */
export interface ClassroomLinkPlan {
  courses: ClassroomCourseLink[];
  identities: ClassroomIdentityLink[];
  unresolved: ClassroomUnresolved[];
}

/** What {@link planClassroomLinks} reads. */
export interface ClassroomLinkInput {
  /** The district's directory, from its own roster source. */
  directory: DistrictDirectorySnapshot;
  /** A client acting as the district's administrator, with `CLASSROOM_ROSTER_SCOPES`. */
  client: GoogleClassroomClient;
  /**
   * The aliases that name each offering. Defaults to `d:<offering ID>`; a district that keys
   * Classroom courses on its SIS section IDs passes those instead.
   */
  aliasesOf?: (offeringId: OfferingId) => readonly string[];
}

/**
 * Proposes course and identity links for every active Classroom course in the domain.
 *
 * A course matches an offering in an active term by alias, else by name and section when exactly
 * one offering has both. Within a matched course, a teacher is matched to a staff member actively
 * teaching the offering and a student to a student actively enrolled in it: by Workspace email
 * when exactly one has it, else by display name when exactly one has it. A member already linked,
 * an account linked to another principal, a principal linked to another account, and a match that
 * differs between two courses are reported, never proposed.
 */
export async function planClassroomLinks(input: ClassroomLinkInput): Promise<ClassroomLinkPlan> {
  const directory = DistrictDirectorySnapshot.parse(input.directory);
  const aliasesOf = input.aliasesOf ?? ((offeringId: OfferingId) => [`d:${offeringId}`]);
  const unresolved: ClassroomUnresolved[] = [];

  const activeTerms = new Set(directory.terms.filter((t) => t.state === "active").map((t) => t.id));
  const offerings = directory.offerings.filter((o) => activeTerms.has(o.termId));
  const titleOf = new Map(directory.courses.map((c) => [c.id, c.title]));
  const offeringByAlias = new Map<string, OfferingId>();
  for (const offering of offerings) for (const alias of aliasesOf(offering.id)) offeringByAlias.set(alias, offering.id);

  const listed = await input.client.listCourses(["ACTIVE"]);
  for (const bad of listed.invalid) {
    unresolved.push({ courseId: "", reason: "unreadable-record", message: `Classroom listed a course EducateOS cannot read (${bad.message})` });
  }
  const courses = listed.records.toSorted((a, b) => compare(a.id, b.id));
  const candidates: ClassroomCourseLink[] = [];
  for (const course of courses) {
    const byAlias = new Set<OfferingId>();
    for (const alias of await input.client.listAliases(course.id)) {
      const offering = offeringByAlias.get(alias);
      if (offering !== undefined) byAlias.add(offering);
    }
    if (byAlias.size === 1) {
      candidates.push({ courseId: course.id, offeringId: [...byAlias][0]!, basis: "alias" });
      continue;
    }
    if (byAlias.size > 1) {
      unresolved.push({ courseId: course.id, reason: "ambiguous-offering", message: `${label(course)} has aliases naming ${byAlias.size} offerings` });
      continue;
    }
    const byName = offerings.filter((o) => same(titleOf.get(o.courseId), course.name) && same(o.sectionName, course.section));
    if (byName.length === 1) candidates.push({ courseId: course.id, offeringId: byName[0]!.id, basis: "name-and-section" });
    else {
      unresolved.push({
        courseId: course.id,
        reason: byName.length === 0 ? "no-matching-offering" : "ambiguous-offering",
        message: byName.length === 0
          ? `${label(course)} matches no offering by alias, or by name and section`
          : `${label(course)} matches ${byName.length} offerings by name and section`,
      });
    }
  }
  // An offering two courses claim is linked to neither.
  const claims = new Map<OfferingId, number>();
  for (const c of candidates) claims.set(c.offeringId, (claims.get(c.offeringId) ?? 0) + 1);
  const linked: ClassroomCourseLink[] = [];
  for (const c of candidates) {
    if (claims.get(c.offeringId) === 1) linked.push(c);
    else unresolved.push({ courseId: c.courseId, reason: "ambiguous-offering", message: `another Classroom course also matches offering ${c.offeringId}` });
  }

  // Identity matches, gathered across every linked course before any is proposed.
  const googleOwner = new Map<string, PrincipalId>();
  const googleOf = new Map<PrincipalId, string>();
  for (const p of directory.principals) {
    for (const identity of p.externalIdentities) {
      if (identity.issuer !== CLASSROOM_ISSUER) continue;
      googleOwner.set(identity.subject, p.id);
      googleOf.set(p.id, identity.subject);
    }
  }
  const principals = new Map(directory.principals.map((p) => [p.id, p]));
  const proposals = new Map<string, ClassroomIdentityLink[]>();
  for (const link of linked) {
    const enrolled = (roles: readonly string[]) => directory.enrollments
      .filter((e) => e.offeringId === link.offeringId && e.status === "active" && roles.includes(e.role))
      .map((e) => principals.get(e.principalId)!)
      .filter((p) => p.status === "active");
    for (const [role, read] of [
      ["teacher", await input.client.listTeachers(link.courseId)],
      ["student", await input.client.listStudents(link.courseId)],
    ] as const) {
      for (const bad of read.invalid) {
        unresolved.push({ courseId: link.courseId, reason: "unreadable-record", message: `Classroom listed a ${role} EducateOS cannot read (${bad.message})` });
      }
      const members = read.records;
      const pool = enrolled(role === "teacher" ? ["teacher", "co-teacher"] : ["student"]).filter((p) => p.kind === (role === "teacher" ? "staff" : "student"));
      for (const member of members) {
        const owner = googleOwner.get(member.userId);
        if (owner !== undefined) {
          if (!pool.some((p) => p.id === owner)) {
            unresolved.push({ courseId: link.courseId, userId: member.userId, reason: "account-linked-elsewhere", message: `the ${role} ${nameOf(member)} is already linked to a principal not in this offering` });
          }
          continue;
        }
        const match = matchMember(member, pool);
        if ("reason" in match) {
          unresolved.push({ courseId: link.courseId, userId: member.userId, reason: match.reason, message: `the ${role} ${nameOf(member)} ${match.message}` });
          continue;
        }
        const existing = googleOf.get(match.principal.id);
        if (existing !== undefined) {
          unresolved.push({ courseId: link.courseId, userId: member.userId, reason: "principal-linked-elsewhere", message: `the ${role} ${nameOf(member)} matches a principal already linked to another Google account` });
          continue;
        }
        const list = proposals.get(member.userId) ?? [];
        list.push({ principalId: match.principal.id, subject: member.userId, courseId: link.courseId, basis: match.basis });
        proposals.set(member.userId, list);
      }
    }
  }
  const identities: ClassroomIdentityLink[] = [];
  const subjectsOf = new Map<PrincipalId, Set<string>>();
  for (const list of proposals.values()) {
    for (const p of list) subjectsOf.set(p.principalId, (subjectsOf.get(p.principalId) ?? new Set()).add(p.subject));
  }
  for (const [subject, list] of [...proposals].toSorted(([a], [b]) => compare(a, b))) {
    const targets = new Set(list.map((p) => p.principalId));
    const first = list[0]!;
    if (targets.size > 1 || subjectsOf.get(first.principalId)!.size > 1) {
      unresolved.push({ courseId: first.courseId, userId: subject, reason: "inconsistent-match", message: "the account and principal do not match one to one across courses" });
      continue;
    }
    // The strongest basis any course gave.
    identities.push({ ...first, basis: list.some((p) => p.basis === "email") ? "email" : "name" });
  }
  return { courses: linked, identities, unresolved };
}

/** What an administrator accepted, and the grade authority Classroom routes are recorded under. */
export interface ClassroomLinkApply {
  directory: DistrictDirectorySnapshot;
  /** The course links accepted, from a plan. */
  courses: readonly ClassroomCourseLink[];
  /** The identity links accepted, from a plan. Each names a course among `courses`. */
  identities: readonly ClassroomIdentityLink[];
  /** The grade authority of the routes made, such as `lms:cv-classroom`. */
  authority: GradeAuthority;
  /**
   * Whether the administrator confirmed each name-based identity link one by one. Without it, a
   * `name` link is refused: a name is not an identity.
   */
  acceptNameMatches?: boolean;
}

const GOOGLE_USER_ID = /^\d{1,32}$/;
const ADMIN_ROLES: ReadonlySet<string> = new Set(["district-admin", "school-admin", "curriculum-admin"]);

/**
 * Applies accepted links: each identity becomes a `https://accounts.google.com` external identity
 * on its principal, and each course link a Classroom grade route. Nothing is applied unless every
 * link holds against the directory as it stands, so a plan that went stale, or was altered on its
 * way back from an administrator, is refused rather than trusted:
 *
 * - a course link names an offering in the directory, and no offering or course twice;
 * - an identity link names a numeric Google user ID no principal holds, and an active student or
 *   staff principal with no Google account yet and no administrator role, actively enrolled (as a
 *   student, or teaching) in the offering of an accepted course link with the same course;
 * - a `name` link is applied only with `acceptNameMatches`.
 *
 * The district must trust Google's issuer: a principal's identities may come only from issuers
 * its district trusts. Trusting it lets a linked Google account sign in as that principal, so it
 * is the district's decision, never made here.
 */
export function applyClassroomLinks(input: ClassroomLinkApply): { directory: DistrictDirectorySnapshot; routes: ClassroomGradeRoute[] } {
  const directory = DistrictDirectorySnapshot.parse(input.directory);
  if (!directory.district.trustedIssuers.includes(CLASSROOM_ISSUER)) {
    throw new EducateOsError("conflict", `Linking Google accounts needs the district to trust ${CLASSROOM_ISSUER}.`);
  }
  const districtId = directory.district.id;

  const offeringIds = new Set(directory.offerings.map((o) => o.id));
  const offeringOfCourse = new Map<string, OfferingId>();
  const seen = new Set<string>();
  const routes = input.courses.map((link) => {
    if (!offeringIds.has(link.offeringId)) throw new EducateOsError("not-found", `No offering ${link.offeringId}.`);
    if (seen.has(link.offeringId) || seen.has(link.courseId)) throw new EducateOsError("conflict", "An offering or course is linked twice.");
    seen.add(link.offeringId).add(link.courseId);
    offeringOfCourse.set(link.courseId, link.offeringId);
    return ClassroomGradeRoute.parse({ offeringId: link.offeringId, authority: input.authority, via: "google-classroom", courseId: link.courseId });
  });

  const owners = new Map<string, PrincipalId>();
  for (const p of directory.principals) for (const i of p.externalIdentities) owners.set(externalIdentityKey(i), p.id);
  const additions = new Map<PrincipalId, string>();
  const added = new Set<string>();
  for (const link of input.identities) {
    const refuse = (message: string): never => {
      throw new EducateOsError("conflict", `Cannot link ${link.principalId}: ${message}`);
    };
    if (!GOOGLE_USER_ID.test(link.subject)) refuse("the Google user ID is malformed.");
    if (link.basis !== "email" && !(link.basis === "name" && input.acceptNameMatches === true)) {
      refuse("a name match must be confirmed one by one (acceptNameMatches).");
    }
    const principal = directory.principals.find((p) => p.id === link.principalId);
    if (principal === undefined) throw new EducateOsError("not-found", `No principal ${link.principalId}.`);
    if (principal.status !== "active" || (principal.kind !== "student" && principal.kind !== "staff")) refuse("only an active student or staff member can be linked.");
    if (directory.roleAssignments.some((r) => r.principalId === principal.id && ADMIN_ROLES.has(r.role))) {
      refuse("an administrator's Google account is linked by hand, never from a Classroom roster.");
    }
    const offering = offeringOfCourse.get(link.courseId);
    if (offering === undefined) refuse(`its course ${link.courseId} is not among the accepted course links.`);
    const roles = principal.kind === "student" ? ["student"] : ["teacher", "co-teacher"];
    const enrolled = directory.enrollments.some((e) => e.offeringId === offering && e.principalId === principal.id && e.status === "active" && roles.includes(e.role));
    if (!enrolled) refuse(`they are not actively enrolled in ${offering}.`);
    if (principal.externalIdentities.some((i) => i.issuer === CLASSROOM_ISSUER)) refuse("they are already linked to a Google account.");
    const key = externalIdentityKey({ districtId, issuer: CLASSROOM_ISSUER, subject: link.subject });
    if (owners.has(key) || additions.has(principal.id) || added.has(link.subject)) refuse(`Google account ${link.subject} or the principal is linked twice.`);
    additions.set(principal.id, link.subject);
    added.add(link.subject);
  }

  const next = DistrictDirectorySnapshot.parse({
    ...directory,
    principals: directory.principals.map((p) => {
      const subject = additions.get(p.id);
      return subject === undefined ? p : Principal.parse({ ...p, externalIdentities: [...p.externalIdentities, { districtId, issuer: CLASSROOM_ISSUER, subject }] });
    }),
  });
  const issues = checkDirectoryIntegrity(next);
  if (issues.length > 0) throw new EducateOsError("conflict", `The links would break the directory: ${issues[0]!.message}`);
  return { directory: next, routes };
}

type Match =
  | { principal: Principal; basis: "email" | "name" }
  | { reason: "no-matching-principal" | "ambiguous-principal" | "email-mismatch"; message: string };

/**
 * A roster member's principal: by exact email, else by name when the email cannot contradict it.
 * When the account's email and the name-matched principal's email are on the same domain and
 * differ, they are different people with the same name (a sibling, a namesake), so nothing is
 * proposed.
 */
function matchMember(member: ClassroomMember, pool: readonly Principal[]): Match {
  const email = member.profile?.emailAddress?.toLowerCase();
  if (email !== undefined) {
    const byEmail = pool.filter((p) => p.email?.toLowerCase() === email);
    if (byEmail.length === 1) return { principal: byEmail[0]!, basis: "email" };
    if (byEmail.length > 1) return { reason: "ambiguous-principal", message: `shares their email with ${byEmail.length} people enrolled in the offering` };
  }
  const name = nameOf(member);
  const byName = pool.filter((p) => same(p.displayName, name));
  if (byName.length === 1) {
    const principal = byName[0]!;
    if (email !== undefined && principal.email !== undefined && domainOf(principal.email) === domainOf(email)) {
      return { reason: "email-mismatch", message: "matches someone enrolled in the offering by name, but their emails on the same domain differ" };
    }
    return { principal, basis: "name" };
  }
  return byName.length === 0
    ? { reason: "no-matching-principal", message: "matches nobody enrolled in the offering by email or name" }
    : { reason: "ambiguous-principal", message: `matches ${byName.length} people enrolled in the offering by name` };
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

function nameOf(member: ClassroomMember): string {
  const name = member.profile?.name;
  return name?.fullName ?? [name?.givenName, name?.familyName].filter(Boolean).join(" ");
}

function label(course: ClassroomCourse): string {
  return `Classroom course ${course.id} (${course.name}${course.section === undefined ? "" : `, ${course.section}`})`;
}

function same(a: string | undefined, b: string | undefined): boolean {
  const norm = (s: string | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return a !== undefined && b !== undefined && norm(a) !== "" && norm(a) === norm(b);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
