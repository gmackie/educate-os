import { z } from "zod";
import {
  Action,
  Classification,
  Decision,
  GUARDIAN_READABLE_KINDS,
  PolicySettings,
  PrincipalKind,
  RequestChannel,
  ResourceKind,
  SchoolRole,
  TermState,
} from "@schoolos/contracts";
import { Relationship } from "./information.ts";

/**
 * How the resource's owner relates to the subject: the subject owns it, someone else does, or it
 * has no owner (a class's shared workspace, a rubric).
 */
export const Ownership = z.enum(["own", "others", "unowned"]);
/** An ownership relation. */
export type Ownership = z.infer<typeof Ownership>;

/** Values of a policy-floor setting that a rule applies under. */
const policyValues = <K extends keyof typeof PolicySettings.shape>(key: K) =>
  z.array(PolicySettings.shape[key]).min(1).optional();

/**
 * When a rule applies. Every listed field must match; an omitted field matches anything. Lists
 * match when the request's value is any of their members.
 *
 * Everything here is evaluated against trusted facts only: the parsed request (built by the
 * service from stored records), the subject's directory roles, and the effective policy floor.
 */
export const RuleCondition = z.strictObject({
  /** The kinds of principal the subject may be, read from the directory (a guardian, a student). */
  principalKinds: z.array(PrincipalKind).min(1).optional(),
  /** The requested actions. */
  actions: z.array(Action).min(1).optional(),
  /** The resource kinds. */
  kinds: z.array(ResourceKind).min(1).optional(),
  /** The resource classifications. */
  classifications: z.array(Classification).min(1).optional(),
  /** The channels the request may arrive through. */
  channels: z.array(RequestChannel).min(1).optional(),
  /**
   * The states of the term the resource belongs to. A request with no term state never matches a
   * rule that lists some.
   */
  termStates: z.array(TermState).min(1).optional(),
  /** The subject must hold one of these roles at a scope that contains the resource's scope. */
  roles: z.array(SchoolRole).min(1).optional(),
  /** How the resource's owner relates to the subject. */
  ownership: z.array(Ownership).min(1).optional(),
  /**
   * The subject must hold one of these relationships to this specific resource, established by a
   * stored record (see `RelationshipSource`). Only an active principal holds any.
   */
  relationships: z.array(Relationship).min(1).optional(),
  /** The effective policy floor at the resource's scope must have one of these values per setting. */
  policy: z.strictObject({
    aiSpending: policyValues("aiSpending"),
    promptsInGatewayLogs: policyValues("promptsInGatewayLogs"),
    studentPersonalConversations: policyValues("studentPersonalConversations"),
    teacherObservation: policyValues("teacherObservation"),
    automatedSelProfiling: policyValues("automatedSelProfiling"),
  }).optional(),
});
/** A rule condition. */
export type RuleCondition = z.infer<typeof RuleCondition>;

/**
 * One named rule. Its `id` is recorded with every decision it makes, so an audit entry always
 * names the exact rule responsible.
 */
export const PolicyRule = z.strictObject({
  /** A stable dotted name, such as `course.instructor.read`. */
  id: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/),
  /** What the rule allows or forbids, and why, for administrators reading an audit trail. */
  description: z.string().min(1).max(500),
  /** When the rule applies. */
  when: RuleCondition,
  /** The decision it makes when it applies. */
  effect: Decision,
});
/** A policy rule. */
export type PolicyRule = z.infer<typeof PolicyRule>;

/**
 * An ordered rule table. The first rule whose condition matches decides, so guards that deny come
 * before the grants they protect. Rule IDs are unique.
 */
export const PolicyRuleTable = z.array(PolicyRule).min(1).superRefine((rules, ctx) => {
  const seen = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (seen.has(rule.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: `duplicate rule id ${rule.id}` });
    seen.add(rule.id);
  }
});

/** The rule ID recorded when nothing in the table matched. */
export const DEFAULT_DENY_RULE_ID = "default.deny";

const READS = ["read", "list"] as const satisfies Action[];

/** Actions that change something. Everything except reading, listing, exporting and invoking a tool. */
export const WRITE_ACTIONS = [
  "create",
  "update",
  "delete",
  "submit",
  "review",
  "grade",
  "publish",
  "approve",
  "assign",
  "share",
  "configure",
] as const satisfies Action[];

/** Resource kinds that belong to a course offering, and so to its term. */
export const COURSE_RESOURCE_KINDS = [
  "offering",
  "enrollment",
  "course-workspace",
  "shared-conversation",
  "artifact",
  "submission",
  "activity",
  "rubric",
  "assessment-run",
  "feedback",
  "official-grade",
  "announcement",
  "course-content",
  "gradebook",
] as const satisfies ResourceKind[];

const OFFICIAL_GRADE_WRITES = ["create", "update", "grade"] as const satisfies Action[];
const ADMINS = ["district-admin", "school-admin"] as const satisfies z.infer<typeof SchoolRole>[];
/** The kinds an appeal grant may name: one student's submitted work and the feedback on it. */
export const APPEAL_RESOURCE_KINDS = ["submission", "artifact", "feedback"] as const satisfies ResourceKind[];
const INSTRUCTORS = ["teacher", "co-teacher"] as const satisfies z.infer<typeof SchoolRole>[];
/** Content everyone with standing in a course may see. Never `teacher-only`, `personal-private` or `restricted`. */
const COURSE_VISIBLE = ["public", "district-internal", "course"] as const satisfies Classification[];
/** What instructional staff and administrators may see in a course: course content plus teacher-only materials. */
const STAFF_VISIBLE = [...COURSE_VISIBLE, "teacher-only"] as const satisfies Classification[];

/**
 * The SchoolOS v1 rule table (roadmap §8, ADR-0005). Decisions it encodes that A01 left open:
 *
 * - **Terms and catalog courses** are district reference data: any principal of the district may
 *   read them. They hold no student data.
 * - **Offerings** are readable by the principals actively enrolled in them (students and staff) and
 *   by administrators over them. Students cannot read rosters; they read their own enrollments.
 * - **Roster-sourced offering roles need an active enrollment.** That check lives in the policy
 *   information point (`subjectFactsFrom`), so a dropped teacher or student stops matching every
 *   rule below that names a role at the offering.
 * - **A dropped student keeps their own work.** The owner rules do not require an enrollment, so
 *   after a drop a student still reads and exports their artifacts, submissions, feedback and
 *   grades in that offering, but can no longer change them or see the class's live material.
 * - **Completed terms are read-only** for every course resource, including official grades and
 *   enrollments, for everyone. A `grading` term still accepts grades.
 * - **Co-teachers** have a teacher's read and course-management access, but their official-grade
 *   writes, like any grade write through an agent or MCP tool, wait for a teacher's approval.
 * - **Class baselines** are unowned `course` artifacts at the offering: its instructors create and
 *   publish them, and its actively enrolled students read them. A student's own work is never
 *   unowned, so these rules never reach it.
 * - **Administrators** see the directory, governance records and course structure (activities,
 *   rubrics, the shared course workspace, official grades). They do not see student-authored work
 *   or any conversation, with one audited exception: an appeal grant (SCHO-56) lets a named
 *   administrator read one named piece of a student's `course` work until it expires.
 * - **`personal-private` content is its owner's**, with two exceptions placed above the guard that
 *   protects it. A district admin may list personal workspace *records* for retention, never read
 *   one. And a principal the owner shared an artifact with reads it, but only while the policy
 *   floor lets students share personal material (`studentPersonalConversations:
 *   shared-by-student`); under a `private` floor the owner cannot share it at all (SCHO-103).
 * - **Activities** come in two classifications. A `teacher-only` activity is a curriculum
 *   definition (answer keys and teacher notes included): only a teacher of the offering authors,
 *   publishes and installs it, installing only into a planned or active term, and a student is
 *   refused it outright. A `course` activity is the student-visible assignment, which all course
 *   staff manage (SCHO-87, from C05's local rules).
 * - **Learning resources in the Content Studio** are `teacher-only` items at their target scope. A
 *   teacher imports and approves for the classes they teach; a curriculum admin works at any scope
 *   their grant covers, reviews items a teacher may not approve alone, and alone widens rights
 *   (SCHO-87, from C03's local rules).
 * - **Guardians** read, and only read, their child's offerings, course assignments, released
 *   feedback, official grades and announcements, through a confirmed guardian relationship that is
 *   in force (ADR-0012). Their two rules come first, so no other rule (a district-wide reference
 *   read, a tool, a share) can ever match a guardian; anything else a guardian asks is denied.
 * - **Announcements** are unowned `course` notices at an offering: its instructors post them, and
 *   its actively enrolled students, their guardians and administrators over it read them.
 * - **Course content** (SCHO-186) is an offering's modules and pages: unowned, authored by all of
 *   its staff. A draft module is `teacher-only`, so only staff and administrators over the offering
 *   see it; publishing makes it `course` material its actively enrolled students read. Guardians
 *   are not given it: what they read stays the ADR-0012 list.
 * - **Gradebooks** (SCHO-187) are computed from official grades. An offering's class grid is
 *   `teacher-only`: its staff read and export it and administrators over it read it, but only a
 *   teacher acting directly sets its groups, weights, scale and markers, because those change every
 *   computed total (never an official grade). A student's own row is a `course` record they own and
 *   read, even after a drop; no student reads the grid. Guardians are not given it.
 */
export const DEFAULT_POLICY_RULES: readonly PolicyRule[] = PolicyRuleTable.parse([
  // Guardians (ADR-0012). Their authority is a relationship record to one child, never a role, and
  // read-only; the catch-all below keeps every other rule in the table from reaching them.
  {
    id: "guardian.child.read",
    description: "A guardian reads their child's offerings, assignments, released feedback, official grades and announcements through a confirmed, in-force guardian relationship; each read is audited with it.",
    when: {
      principalKinds: ["guardian"],
      kinds: [...GUARDIAN_READABLE_KINDS],
      ownership: ["others", "unowned"],
      relationships: ["guardian-of"],
      classifications: [...COURSE_VISIBLE],
      actions: [...READS],
    },
    effect: { effect: "allow" },
  },
  {
    id: "guard.guardian.child-records-only",
    description: "A guardian may do nothing else: no writes, no personal spaces or conversations, no submissions, no other children, no tools or directory.",
    when: { principalKinds: ["guardian"] },
    effect: { effect: "deny", reason: "no-matching-grant" },
  },

  // Exceptions to the personal guards, each narrower than the guard it precedes: a metadata-only
  // listing for retention, and a read the owner consented to by sharing (SCHO-56, SCHO-103).
  {
    id: "admin.retention.personal-workspace-records",
    description: "A district admin lists the district's personal workspace records (owner, dates, legal hold) for retention; this never reads one or its content.",
    when: {
      kinds: ["personal-workspace"],
      ownership: ["unowned"],
      classifications: ["personal-private"],
      roles: ["district-admin"],
      actions: ["list"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "share.grantee.read",
    description: "A principal an artifact's owner shared it with reads it, while the policy floor lets students share personal material.",
    when: {
      kinds: ["artifact"],
      classifications: ["personal-private"],
      ownership: ["others"],
      relationships: ["share-grantee"],
      actions: ["read"],
      policy: { studentPersonalConversations: ["shared-by-student"] },
    },
    effect: { effect: "allow" },
  },

  // Guards. These deny before any grant below can match.
  {
    id: "guard.personal.owner-only",
    description: "Personal workspaces and conversations belong to their owner alone: not teachers, not administrators.",
    when: { kinds: ["personal-workspace", "personal-conversation"], ownership: ["others", "unowned"] },
    effect: { effect: "deny", reason: "owner-only" },
  },
  {
    id: "guard.personal-private.owner-only",
    description: "Content classified personal-private is visible only to its owner, whatever kind of resource holds it.",
    when: { classifications: ["personal-private"], ownership: ["others", "unowned"] },
    effect: { effect: "deny", reason: "classification-restricted" },
  },
  {
    id: "guard.personal-private.no-sharing",
    description: "When the policy floor keeps student conversations private, personal-private content cannot be shared, even by its owner.",
    when: { classifications: ["personal-private"], actions: ["share"], policy: { studentPersonalConversations: ["private"] } },
    effect: { effect: "deny", reason: "policy-floor" },
  },
  {
    id: "guard.term-completed.read-only",
    description: "Course resources in a completed term are kept but read-only, including grades and enrollments.",
    when: { kinds: [...COURSE_RESOURCE_KINDS], actions: [...WRITE_ACTIONS], termStates: ["completed"] },
    effect: { effect: "deny", reason: "term-not-active" },
  },
  {
    id: "guard.shared-conversation.observation-floor",
    description: "When the policy floor limits teachers to assigned work, nobody but the student sees a shared conversation.",
    when: { kinds: ["shared-conversation"], ownership: ["others", "unowned"], policy: { teacherObservation: ["assigned-work-only"] } },
    effect: { effect: "deny", reason: "policy-floor" },
  },
  {
    id: "guard.shared-conversation.private-floor",
    description: "When the policy floor keeps student conversations private, a shared conversation is visible only to its owner.",
    when: { kinds: ["shared-conversation"], ownership: ["others", "unowned"], policy: { studentPersonalConversations: ["private"] } },
    effect: { effect: "deny", reason: "policy-floor" },
  },
  {
    id: "guard.personal-conversation.no-sharing",
    description: "When the policy floor keeps student conversations private, a personal conversation cannot be shared.",
    when: { kinds: ["personal-conversation"], actions: ["share"], policy: { studentPersonalConversations: ["private"] } },
    effect: { effect: "deny", reason: "policy-floor" },
  },

  // Personal space: the owner, and only the owner.
  {
    id: "personal.owner",
    description: "A principal manages their own personal workspaces and conversations.",
    when: {
      kinds: ["personal-workspace", "personal-conversation"],
      ownership: ["own"],
      actions: ["read", "list", "create", "update", "delete", "share", "export", "invoke-tool"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "personal.owner-artifacts",
    description: "A principal manages their own personal-private artifacts.",
    when: {
      kinds: ["artifact"],
      classifications: ["personal-private"],
      ownership: ["own"],
      actions: ["read", "list", "create", "update", "delete", "share", "export"],
    },
    effect: { effect: "allow" },
  },

  // Official grades. Ordered before the general course rules so nothing else can write one.
  {
    id: "grade.official.teacher-direct",
    description: "A teacher of the offering writes or approves an official grade directly, through the SchoolOS UI or API.",
    when: {
      kinds: ["official-grade"],
      actions: [...OFFICIAL_GRADE_WRITES, "approve"],
      roles: ["teacher"],
      channels: ["http"],
      classifications: ["course"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "grade.official.needs-teacher-review",
    description: "Any other official-grade write by course staff or an administrator, including every write through an agent or tool, waits for a teacher's approval.",
    when: { kinds: ["official-grade"], actions: [...OFFICIAL_GRADE_WRITES], roles: [...INSTRUCTORS, ...ADMINS], classifications: ["course"] },
    effect: { effect: "require-approval", reason: "requires-teacher-review" },
  },

  // Shared conversations.
  {
    id: "shared-conversation.owner",
    description: "A student reads, updates, unshares or deletes a conversation they shared.",
    when: { kinds: ["shared-conversation"], ownership: ["own"], actions: ["read", "list", "update", "delete", "share", "export"] },
    effect: { effect: "allow" },
  },
  {
    id: "shared-conversation.instructor-read",
    description: "Course staff read a conversation a student explicitly shared with the offering, when the policy floor permits it.",
    when: {
      kinds: ["shared-conversation"],
      roles: [...INSTRUCTORS],
      classifications: ["course"],
      actions: [...READS],
      policy: {
        teacherObservation: ["assigned-work-and-shared-conversations"],
        studentPersonalConversations: ["shared-by-student"],
      },
    },
    effect: { effect: "allow" },
  },

  // A principal's own course records, which survive a drop.
  {
    id: "course.owner.read-own",
    description: "A principal reads and exports their own course work, feedback, grades and enrollments, even after leaving the offering.",
    when: {
      kinds: ["enrollment", "course-workspace", "artifact", "submission", "feedback", "official-grade", "gradebook"],
      ownership: ["own"],
      classifications: ["course"],
      actions: ["read", "list", "export"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "course.student.own-work",
    description: "An actively enrolled student creates, edits and submits their own course work.",
    when: {
      kinds: ["course-workspace", "artifact", "submission"],
      ownership: ["own"],
      roles: ["student"],
      classifications: ["course"],
      actions: ["create", "update", "submit"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "course.student.read",
    description: "An actively enrolled student reads the offering and its class material, never other students' work or teacher-only material.",
    when: {
      kinds: ["offering", "course-workspace", "activity", "rubric", "learning-resource", "announcement", "course-content"],
      ownership: ["unowned", "own"],
      roles: ["student"],
      classifications: [...COURSE_VISIBLE],
      actions: [...READS],
    },
    effect: { effect: "allow" },
  },

  // Class baselines: starter material a teacher publishes to the whole offering (SCHO-81).
  {
    id: "course.instructor.baseline",
    description: "Course staff create and publish unowned course baselines, such as assignment starter material, for their offering.",
    when: {
      kinds: ["artifact"],
      ownership: ["unowned"],
      roles: [...INSTRUCTORS],
      classifications: ["course"],
      actions: ["create", "publish"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "course.student.baseline-read",
    description: "An actively enrolled student reads the unowned course baselines published to their offering, never another student's work.",
    when: { kinds: ["artifact"], ownership: ["unowned"], roles: ["student"], classifications: ["course"], actions: [...READS] },
    effect: { effect: "allow" },
  },

  // Instructional staff.
  {
    id: "course.instructor.read",
    description: "Course staff read their offering's roster, material and assigned student work; never personal-private content.",
    when: {
      kinds: [
        "offering",
        "enrollment",
        "course-workspace",
        "artifact",
        "submission",
        "activity",
        "rubric",
        "assessment-run",
        "feedback",
        "official-grade",
        "learning-resource",
        "announcement",
        "course-content",
        "gradebook",
      ],
      roles: [...INSTRUCTORS],
      classifications: [...STAFF_VISIBLE],
      actions: [...READS, "export"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "course.instructor.content",
    description: "Course staff author their offering's modules and pages: create, edit, publish, unpublish and remove them.",
    when: {
      kinds: ["course-content"],
      ownership: ["unowned"],
      roles: [...INSTRUCTORS],
      classifications: ["course", "teacher-only"],
      actions: ["create", "update", "publish", "delete"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "course.instructor.manage",
    description: "Course staff create and publish their offering's rubrics, class workspace, feedback and announcements.",
    when: {
      kinds: ["rubric", "course-workspace", "feedback", "assessment-run", "announcement"],
      ownership: ["unowned", "own"],
      roles: [...INSTRUCTORS],
      classifications: ["course", "teacher-only"],
      actions: ["create", "update", "publish", "assign"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "course.instructor.assignments",
    description: "Course staff create, update, publish and assign their offering's student-visible (course) activities.",
    when: {
      kinds: ["activity"],
      ownership: ["unowned", "own"],
      roles: [...INSTRUCTORS],
      classifications: ["course"],
      actions: ["create", "update", "publish", "assign"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "course.teacher.gradebook",
    description: "A teacher of the offering, acting directly, sets its gradebook's groups, weights, grade scale and missing, excused and late markers; these change computed totals, never an official grade.",
    when: {
      kinds: ["gradebook"],
      ownership: ["unowned"],
      roles: ["teacher"],
      channels: ["http"],
      classifications: ["teacher-only"],
      actions: ["update"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "course.instructor.review",
    description: "Course staff review students' submitted work in their offering.",
    when: { kinds: ["artifact", "submission"], roles: [...INSTRUCTORS], classifications: ["course"], actions: ["review"] },
    effect: { effect: "allow" },
  },

  // Administration.
  {
    id: "admin.district.directory",
    description: "A district admin manages the district's schools, terms, catalog courses, offerings and enrollments, and moves principals between lifecycle statuses.",
    when: {
      kinds: ["district", "school", "term", "course", "offering", "enrollment", "principal"],
      roles: ["district-admin"],
      actions: ["read", "list", "create", "update"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "admin.school.directory",
    description: "A school admin manages their school's record, offerings and enrollments.",
    when: { kinds: ["school", "offering", "enrollment"], roles: ["school-admin"], actions: ["read", "list", "create", "update"] },
    effect: { effect: "allow" },
  },
  {
    id: "admin.course-oversight",
    description: "Administrators read course structure and official grades in their scope, but not student-authored work or conversations.",
    when: {
      kinds: ["activity", "rubric", "course-workspace", "assessment-run", "official-grade", "announcement", "course-content", "gradebook"],
      ownership: ["unowned", "others"],
      roles: [...ADMINS],
      classifications: [...STAFF_VISIBLE],
      actions: [...READS],
    },
    effect: { effect: "allow" },
  },
  {
    id: "appeal.reviewer.read",
    description: "An administrator named by an unexpired appeal grant reads the one piece of a student's course work it names; every read is audited with the grant.",
    when: {
      kinds: [...APPEAL_RESOURCE_KINDS],
      ownership: ["others"],
      relationships: ["appeal-reviewer"],
      roles: [...ADMINS],
      classifications: ["course"],
      actions: ["read"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "admin.appeal-grants.manage",
    description: "A district admin issues, lists and revokes purpose-bound appeal grants in the district.",
    when: { kinds: ["access-grant"], roles: ["district-admin"], classifications: ["restricted"], actions: ["create", "list", "read", "update"] },
    effect: { effect: "allow" },
  },
  {
    id: "admin.governance",
    description: "Administrators read and configure capability settings and AI budgets in their scope.",
    when: { kinds: ["capability-config", "ai-budget"], roles: [...ADMINS], actions: [...READS, "configure"] },
    effect: { effect: "allow" },
  },
  {
    id: "admin.district.identity-links",
    description: "Only a district admin lists and decides pending identity links and Workshop user adoptions: they decide who a sign-in is.",
    when: { kinds: ["identity-link"], roles: ["district-admin"], actions: ["read", "list", "approve"] },
    effect: { effect: "allow" },
  },
  {
    id: "admin.district.guardian-relationships",
    description: "Only a district admin records, confirms, suspends and revokes guardian relationships: they decide who may read a child's records.",
    when: { kinds: ["guardian-relationship"], roles: ["district-admin"], classifications: ["restricted"], actions: ["create", "list", "read", "update", "approve"] },
    effect: { effect: "allow" },
  },
  {
    id: "admin.audit-read",
    description: "Administrators read the content-free policy audit trail in their scope.",
    when: { kinds: ["audit-event"], roles: [...ADMINS], actions: [...READS, "export"] },
    effect: { effect: "allow" },
  },

  // Curriculum.
  {
    id: "curriculum.admin.manage",
    description: "A curriculum admin authors, reviews, approves and publishes learning resources in their scope.",
    when: {
      kinds: ["learning-resource"],
      roles: ["curriculum-admin"],
      classifications: [...STAFF_VISIBLE],
      actions: ["read", "list", "create", "update", "review", "approve", "publish"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "content-studio.teacher.offering",
    description: "A teacher imports, reviews, approves, publishes and uses learning resources for the classes they teach.",
    when: {
      kinds: ["learning-resource"],
      roles: ["teacher"],
      classifications: ["teacher-only"],
      actions: ["create", "list", "read", "update", "approve", "publish", "assign"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "content-studio.curriculum-admin.manage",
    description: "A curriculum admin also uses resources in classes and widens an item's rights.",
    when: { kinds: ["learning-resource"], roles: ["curriculum-admin"], classifications: ["teacher-only"], actions: ["assign", "configure"] },
    effect: { effect: "allow" },
  },
  {
    id: "curriculum.activity.teacher-author",
    description: "A teacher of the offering authors, revises and publishes its activity definitions, answer keys included.",
    when: {
      kinds: ["activity"],
      ownership: ["unowned", "own"],
      roles: ["teacher"],
      classifications: ["teacher-only"],
      actions: ["create", "update", "publish"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "curriculum.activity.teacher-install",
    description: "A teacher of the offering installs an activity definition into it while its term is planned or active.",
    when: {
      kinds: ["activity"],
      ownership: ["unowned", "own"],
      roles: ["teacher"],
      classifications: ["teacher-only"],
      actions: ["assign"],
      termStates: ["planned", "active"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "curriculum.activity.install-needs-open-term",
    description: "An install into a term that is grading, completed or unknown is refused, even for the offering's teacher.",
    when: { kinds: ["activity"], roles: ["teacher"], classifications: ["teacher-only"], actions: ["assign"] },
    effect: { effect: "deny", reason: "term-not-active" },
  },
  {
    id: "curriculum.activity.definition-staff-only",
    description: "A student never reads an activity definition: it holds answer keys and teacher notes. Students read the installed course activity.",
    when: { kinds: ["activity"], roles: ["student"], classifications: ["teacher-only"], actions: [...READS] },
    effect: { effect: "deny", reason: "classification-restricted" },
  },
  {
    id: "curriculum.published.read",
    description: "Any principal of the district reads learning resources published to the district.",
    when: { kinds: ["learning-resource"], classifications: ["public", "district-internal"], actions: [...READS] },
    effect: { effect: "allow" },
  },

  // Tools.
  {
    id: "tool.invoke.district-member",
    description: "Any principal of the district may invoke the district's tools; each tool's operation is then authorized on its own record.",
    when: { kinds: ["district"], classifications: ["district-internal"], actions: ["invoke-tool"] },
    effect: { effect: "allow" },
  },

  // Reference data.
  {
    id: "directory.reference.read",
    description: "Any principal of the district reads its academic terms and catalog courses.",
    when: { kinds: ["term", "course"], classifications: ["public", "district-internal"], actions: [...READS] },
    effect: { effect: "allow" },
  },
]);
