// Guidance and Evidence route handlers. Mounted from app.ts with one call, like the guardian
// handlers, so this feature's wiring stays out of the core app file. Every handler is decided by
// the district's policy engine through `ctx.require` / `ctx.decider`; nothing here widens a
// guardian relationship. A guardian reaches `learning-guidance` only through the separate
// administrator grant (`guardianGuidanceRelationships`), and only to suggest or read a summary.
import {
  EducateOsError,
  guardianRelationshipInForce,
  type Action,
  type Caller,
  type DistrictDirectorySnapshot,
  type OfferingId,
  type PrincipalId,
  type ResourceRef,
  type VerifiedPrincipal,
} from "@educateos/contracts";
import type { ResolvedPrincipal } from "@educateos/identity";
import type { CatalogMirror } from "@educateos/catalog";
import type { OfferingScope } from "@educateos/curriculum";
import { guardianGuidanceRelationships, nextGuardianGuidanceGrant, type PolicyDecider } from "@educateos/policy";
import {
  computeCoverage, GUARDIAN_PROGRESS_LABEL, GUIDANCE_TRANSPARENCY, guidanceConflict, MAX_OPEN_SUGGESTIONS, MAX_RETAINED_OPEN_SUGGESTIONS, PRACTICE_CATALOG,
  SUGGESTION_VISIBLE_DAYS, SUGGESTION_WAIT_DAYS, suggestionExpired,
  type GuidanceAgenda, type GuidancePractice, type GuidancePriorityInput, type GuidancePreference, type GuidancePriority, type GuidanceRecord, type GuidanceSuggestion,
  type ResolvedStandard, type StudentInvitation,
} from "./guidance.ts";
import { contentDigest } from "@educateos/catalog";
import { learningGoalsFor } from "./standards.ts";
import type { LearningRecipeRecord, LearningRecipeSettings } from "./learning-recipe.ts";
import { STARTER_RECIPES } from "./learning-recipe-starters.ts";
import { latestRecipes, recipeClassOf, verifyRecipeStandard } from "./learning-recipe-approval.ts";
import type { PlannerPlan } from "./planner.ts";
import type { ParsedRouteInput, RouteResponse } from "./routes.ts";
import type { DistrictAppStores } from "./stores.ts";

/** The routes this module handles. */
export type GuidanceRouteName =
  | "teacher.guidance" | "teacher.guidanceAgenda" | "teacher.guidanceEvidence" | "teacher.guidanceSuggestionReview" | "teacher.guidancePracticeInvite"
  | "student.guidance" | "student.guidanceRespond" | "student.guidancePreference"
  | "guardian.guidance" | "guardian.guidanceSuggest" | "guardian.guidanceWithdraw"
  | "admin.guardianGuidance" | "admin.setGuardianGuidance"
  | "teacher.recipes" | "teacher.recipeDecision" | "teacher.recipeSettings";

/** What the handlers need from app.ts's request context. */
export interface GuidanceRequestContext {
  readonly principal: Pick<ResolvedPrincipal, "districtId" | "principalId">;
  readonly snapshot: DistrictDirectorySnapshot;
  readonly caller: Caller;
  readonly subject: VerifiedPrincipal;
  readonly decider: PolicyDecider;
  offeringScope(offeringId: OfferingId): OfferingScope;
  require(action: Action, resource: ResourceRef, message: string): Promise<void>;
}

/** What the handlers are built from. */
export interface GuidanceHandlerOptions {
  stores: DistrictAppStores;
  catalog: CatalogMirror;
  now: () => Date;
}

type GuidanceHandlers<C> = { [N in GuidanceRouteName]: (ctx: C, input: ParsedRouteInput<N>) => Promise<RouteResponse<N>> };

const DAY = 24 * 60 * 60 * 1000;
const notFound = () => new EducateOsError("not-found", "We couldn't find that.");
const NOTICE = "These are suggestions, never assignments. Your child's teacher decides what, if anything, becomes classwork.";

/** The guidance handlers. */
export function guidanceHandlers<C extends GuidanceRequestContext>(options: GuidanceHandlerOptions): GuidanceHandlers<C> {
  const { stores, catalog, now } = options;
  const records = stores.guidance.records;

  // Access. Teachers and students use the same course checks the planner uses: an active
  // enrollment as that role, plus an audited decision from the engine. Default deny otherwise.

  const nameOf = (ctx: C, id: PrincipalId) => ctx.snapshot.principals.find((p) => p.id === id)?.displayName ?? "Unknown";
  const teacherAccess = async (ctx: C, offeringId: OfferingId, write: boolean) => {
    const scope = ctx.offeringScope(offeringId);
    if (!ctx.snapshot.enrollments.some((e) => e.offeringId === offeringId && e.principalId === ctx.principal.principalId && ["teacher", "co-teacher"].includes(e.role) && e.status === "active")) {
      throw new EducateOsError("forbidden", "Only this class's active teachers can use its guidance.");
    }
    await ctx.require(write ? "create" : "read", { kind: write ? "activity" : "rubric", scope, classification: "teacher-only" }, "Only this class's teachers can manage guidance.");
    return scope;
  };
  const activeStudent = (ctx: C, offeringId: OfferingId, studentId: PrincipalId) =>
    ctx.snapshot.principals.some((p) => p.id === studentId && p.kind === "student" && p.status === "active")
    && ctx.snapshot.enrollments.some((e) => e.offeringId === offeringId && e.principalId === studentId && e.role === "student" && e.status === "active");
  const studentAccess = async (ctx: C, offeringId: OfferingId, write: boolean) => {
    const scope = ctx.offeringScope(offeringId);
    if (!activeStudent(ctx, offeringId, ctx.principal.principalId)) throw new EducateOsError("not-found", "This student is not actively enrolled in the class.");
    await ctx.require(write ? "update" : "read", { kind: write ? "submission" : "offering", scope, classification: "course", ...(write ? { ownerPrincipalId: ctx.principal.principalId } : {}) }, "You cannot use this class's guidance.");
    return scope;
  };
  const roster = (ctx: C, offeringId: OfferingId) => ctx.snapshot.enrollments
    .filter((e) => e.offeringId === offeringId && e.role === "student" && e.status === "active" && ctx.snapshot.principals.some((p) => p.id === e.principalId && p.kind === "student" && p.status === "active"))
    .map((e) => ({ id: e.principalId, displayName: nameOf(ctx, e.principalId) }))
    .toSorted((a, b) => a.displayName.localeCompare(b.displayName));

  // Records

  const load = async (scope: string) => records.list(scope);
  const agendaOf = async (offeringId: OfferingId) => (await load(offeringId)).find((r): r is GuidanceAgenda => r.type === "agenda");
  const suggestionsOf = async (offeringId: OfferingId) => (await load(offeringId)).filter((r): r is GuidanceSuggestion => r.type === "suggestion");
  const practiceOf = async (offeringId: OfferingId) => (await load(offeringId)).filter((r): r is GuidancePractice => r.type === "practice");
  const preferenceOf = async (studentId: PrincipalId) => (await load(`student:${studentId}`)).find((r): r is GuidancePreference => r.type === "preference");
  const plansOf = (offeringId: OfferingId) => stores.planner.list(offeringId);

  /** A suggestion past its window, whatever its status. Expired records are kept, never shown. */
  const live = (s: GuidanceSuggestion) => !suggestionExpired(s, now());

  // Standing. A suggestion is posted under a verified relationship and an administrator's grant. Those
  // can end after it is queued (suspension, revocation, expiry, withdrawn consent, a removed grant), so a
  // teacher approving it or a child seeing it re-reads them now, through the same relationship source the
  // policy engine uses, rather than trusting what was true when it was posted. Without standing the record
  // is kept, with its teacher decision and the student's choice, but it is neither actionable nor shown.
  // A teacher's own invitation (practice, planner) is a different record with the teacher as origin and
  // never depends on a guardian's standing.
  const standingSource = guardianGuidanceRelationships(stores.guidance.guardianGrants, stores.guardianRelationships, stores.directory, now);
  const standing = async (ctx: C, s: GuidanceSuggestion): Promise<boolean> => {
    const relationship = await stores.guardianRelationships.get(s.relationshipId as never);
    if (relationship === undefined || relationship.districtId !== ctx.principal.districtId || relationship.guardianPrincipalId !== s.guardianId
      || relationship.studentPrincipalId !== s.studentId || !guardianRelationshipInForce(relationship, now())) return false;
    const resource: ResourceRef = { kind: "learning-guidance", scope: ctx.offeringScope(s.offeringId), classification: "course", ownerPrincipalId: s.studentId };
    if (!(await standingSource.relationships(s.guardianId, resource, "create")).some((fact) => fact.grantId === relationship.id)) return false;
    const grant = await stores.guidance.guardianGrants.get(relationship.id);
    if (grant === undefined) return false;
    // Every grant change since it was posted must still name `suggest`; a revocation is not undone by a new grant.
    const since = s.grantRevision !== undefined ? grant.history.slice(s.grantRevision) : grant.history.filter((e) => Date.parse(e.at) >= Date.parse(s.createdAt));
    return since.every((event) => event.capabilities.includes("suggest"));
  };
  const withStanding = async (ctx: C, list: readonly GuidanceSuggestion[]) => {
    const kept = await Promise.all(list.map(async (s) => await standing(ctx, s)));
    return list.filter((_, i) => kept[i]);
  };

  // Standards

  /** The standard against the district's approved releases now. `unmapped` and `not-approved` are explicit. */
  const resolve = async (frameworkKey: string, competencyUri: string, known: { code: string; statement: string }): Promise<ResolvedStandard> => {
    const mirror = await catalog.get(frameworkKey);
    const approved = mirror?.releases.find((r) => r.status === "approved");
    if (approved === undefined || mirror === undefined) return { state: "not-approved", ...known };
    const node = approved.release.content.nodes?.find((n) => n.uri === competencyUri);
    if (node === undefined) return { state: "unmapped", ...known };
    const framework = approved.release.content.framework;
    return {
      state: mirror.overlays.some((o) => o.nodeUri === node.uri && o.hidden === true) ? "hidden" : "approved",
      code: node.humanCodingScheme ?? known.code, statement: node.fullStatement,
      frameworkTitle: framework.title, ...(framework.publisher === undefined ? {} : { publisher: framework.publisher }),
      releaseVersion: approved.release.version, provenance: node.provenance.source,
    };
  };

  const coverageFor = async (ctx: C, offeringId: OfferingId, students = roster(ctx, offeringId)) =>
    computeCoverage({ roster: students, plans: await plansOf(offeringId), priorities: (await agendaOf(offeringId))?.priorities ?? [], resolve });

  // Views

  const teacherBody = async (ctx: C, offeringId: OfferingId): Promise<RouteResponse<"teacher.guidance">> => {
    const agenda = await agendaOf(offeringId);
    const { rows } = await coverageFor(ctx, offeringId);
    const people = new Set(roster(ctx, offeringId).map((s) => s.id));
    // A waiting suggestion is listed only while its guardian still has standing; one the teacher already decided stays as history.
    const listed = (await suggestionsOf(offeringId)).filter((s) => live(s) && people.has(s.studentId));
    const waiting = new Set((await withStanding(ctx, listed.filter((s) => s.status === "awaiting-teacher"))).map((s) => s.id));
    return {
      agenda: { revision: agenda?.revision ?? 0, priorities: agenda?.priorities ?? [] },
      coverage: rows,
      suggestions: listed.filter((s) => s.status !== "awaiting-teacher" || waiting.has(s.id)).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).map((s) => ({
        id: s.id, revision: s.revision, studentId: s.studentId, studentName: nameOf(ctx, s.studentId), guardianName: s.guardianName, kind: s.kind, topic: s.topic,
        ...(s.note === undefined ? {} : { note: s.note }), status: s.status, createdAt: s.createdAt, expiresAt: s.expiresAt,
        ...(s.review === undefined ? {} : { review: s.review }),
        // Only an acceptance is visible. A decline is the student's alone.
        studentAccepted: s.student?.decision === "accepted",
      })),
      practice: (await practiceOf(offeringId)).filter((p) => people.has(p.studentId)).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)).map((p) => ({
        id: p.id, studentId: p.studentId, studentName: nameOf(ctx, p.studentId), skill: p.skill, ...(p.note === undefined ? {} : { note: p.note }),
        accepted: p.student?.decision === "accepted", createdAt: p.createdAt,
      })),
      assignmentNote: "Everything on this page is a suggestion. To make something required, use Create activity.",
    };
  };

  const studentBody = async (ctx: C, offeringId: OfferingId): Promise<RouteResponse<"student.guidance">> => {
    const me = ctx.principal.principalId;
    const preference = await preferenceOf(me);
    const invitations: StudentInvitation[] = [];
    for (const plan of (await plansOf(offeringId)).filter((p: PlannerPlan) => p.studentId === me && p.source === "teacher")) {
      const decisions = plan.opportunities.map((o) => o.decision);
      invitations.push({
        id: plan.id, kind: "suggestion", isAssignment: false, required: false, type: "planner-invitation", origin: { kind: "teacher", name: plan.authorName },
        title: plan.goal, decision: decisions.includes("accepted") ? "accepted" : decisions.length > 0 && decisions.every((d) => d === "skipped") ? "declined" : "pending",
        plannerPlanId: plan.id, createdAt: plan.createdAt,
      });
    }
    for (const p of (await practiceOf(offeringId)).filter((r) => r.studentId === me)) {
      const item = PRACTICE_CATALOG[p.skill];
      invitations.push({
        id: p.id, kind: "suggestion", isAssignment: false, required: false, type: "practice", origin: { kind: "teacher", name: p.authorName },
        title: item.title, detail: p.note === undefined ? item.prompt : `${item.prompt} ${p.note}`, area: item.area,
        decision: p.student?.decision ?? "pending", revision: p.revision, createdAt: p.createdAt,
      });
    }
    if (preference?.guardianSuggestions !== "off") {
      for (const s of await withStanding(ctx, (await suggestionsOf(offeringId)).filter((r) => r.studentId === me && r.status === "shared" && live(r)))) {
        invitations.push({
          id: s.id, kind: "suggestion", isAssignment: false, required: false, type: "family-topic", origin: { kind: "guardian", name: s.guardianName },
          title: s.topic, ...(s.note === undefined ? {} : { detail: s.note }), decision: s.student?.decision ?? "pending", revision: s.revision, createdAt: s.createdAt,
        });
      }
    }
    return {
      invitations: invitations.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
      preferences: { guardianSuggestions: preference?.guardianSuggestions ?? "on", revision: preference?.revision ?? 0 },
      transparency: [...GUIDANCE_TRANSPARENCY],
    };
  };

  // Guardians

  /** The guardian's in-force relationships to this child, or `not-found`: a wrong guardian learns nothing. */
  const relationshipsTo = async (ctx: C, studentId: PrincipalId) => {
    const at = now();
    const mine = (await stores.guardianRelationships.listForGuardian(ctx.principal.principalId))
      .filter((r) => r.districtId === ctx.principal.districtId && r.studentPrincipalId === studentId && guardianRelationshipInForce(r, at));
    const student = ctx.snapshot.principals.find((p) => p.id === studentId && p.kind === "student" && p.status === "active");
    if (mine.length === 0 || student === undefined) throw notFound();
    return { relationships: mine, student };
  };
  const guidanceResource = (ctx: C, offeringId: OfferingId, studentId: PrincipalId): ResourceRef => ({
    kind: "learning-guidance", scope: ctx.offeringScope(offeringId), classification: "course", ownerPrincipalId: studentId,
  });
  /** Whether the engine allows `action` on the child's guidance in the class, audited as the guardian. */
  const allowed = async (ctx: C, action: Action, offeringId: OfferingId, studentId: PrincipalId) => {
    const term = ctx.snapshot.terms.find((t) => t.id === ctx.snapshot.offerings.find((o) => o.id === offeringId)?.termId);
    const { decision } = await ctx.decider.decide({
      subject: ctx.subject, action, resource: guidanceResource(ctx, offeringId, studentId), context: { channel: "http", ...(term === undefined ? {} : { termState: term.state }) },
    });
    return decision.effect === "allow";
  };

  const guardianBody = async (ctx: C, studentId: PrincipalId): Promise<RouteResponse<"guardian.guidance">> => {
    const { student } = await relationshipsTo(ctx, studentId);
    const out: RouteResponse<"guardian.guidance">["offerings"] = [];
    let suggest = false, progress = false;
    const offeringIds = [...new Set(ctx.snapshot.enrollments.filter((e) => e.principalId === studentId && e.role === "student" && e.status === "active").map((e) => e.offeringId))];
    for (const offeringId of offeringIds) {
      const canSuggest = await allowed(ctx, "create", offeringId, studentId);
      const canRead = await allowed(ctx, "read", offeringId, studentId);
      if (!canSuggest && !canRead) continue;
      suggest ||= canSuggest;
      progress ||= canRead;
      const offering = ctx.snapshot.offerings.find((o) => o.id === offeringId)!;
      const title = ctx.snapshot.courses.find((c) => c.id === offering.courseId)?.title ?? "Class";
      let summary: NonNullable<RouteResponse<"guardian.guidance">["offerings"][number]["progress"]> | undefined;
      if (canRead) {
        // Only teacher-chosen, currently approved standards, only this child, and only a coarse label.
        const { rows, students } = await coverageFor(ctx, offeringId, [{ id: student.id, displayName: student.displayName }]);
        summary = rows.filter((r) => r.priority !== undefined && r.state === "approved").map((r) => ({
          code: r.code, statement: r.statement, focus: r.priority!.level === "focus",
          label: GUARDIAN_PROGRESS_LABEL[students.get(`${r.frameworkKey}\u0000${r.competencyUri}`)!.get(student.id)!.state],
        }));
      }
      const mine = canSuggest
        ? (await suggestionsOf(offeringId)).filter((s) => s.guardianId === ctx.principal.principalId && s.studentId === studentId && live(s)).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
            // The student's own choice is never reported back to the family.
            .map((s) => ({ id: s.id, revision: s.revision, kind: s.kind, topic: s.topic, ...(s.note === undefined ? {} : { note: s.note }), status: s.status, createdAt: s.createdAt }))
        : undefined;
      out.push({ offeringId, title, ...(summary === undefined ? {} : { progress: summary }), ...(mine === undefined ? {} : { suggestions: mine }) });
    }
    return { child: { principalId: student.id, displayName: student.displayName }, capabilities: { suggest, progress }, offerings: out, notice: NOTICE };
  };

  // Administrators

  const adminResource = (ctx: C): ResourceRef => ({ kind: "guardian-relationship", scope: { level: "district", districtId: ctx.principal.districtId }, classification: "restricted" });
  const adminBody = async (ctx: C, studentId: PrincipalId): Promise<RouteResponse<"admin.guardianGuidance">> => {
    const student = ctx.snapshot.principals.find((p) => p.id === studentId && p.kind === "student");
    if (student === undefined) throw notFound();
    const at = now();
    const grants = new Map((await stores.guidance.guardianGrants.listForStudent(studentId)).map((g) => [g.relationshipId, g]));
    return {
      student: { principalId: student.id, displayName: student.displayName },
      relationships: (await stores.guardianRelationships.listForStudent(studentId)).map((r) => {
        const grant = grants.get(r.id);
        return {
          relationshipId: r.id, guardianDisplayName: ctx.snapshot.principals.find((p) => p.id === r.guardianPrincipalId)?.displayName ?? "Guardian (sign-in not yet approved)", status: r.status, inForce: guardianRelationshipInForce(r, at),
          enabled: grant?.enabled ?? false, capabilities: grant?.capabilities ?? [], revision: grant?.revision ?? 0, history: grant?.history ?? [],
        };
      }),
    };
  };

  /** Validates a priority against what the district approved for this class's course, and pins its code and text. */
  const pin = async (ctx: C, offeringId: OfferingId, input: GuidancePriorityInput): Promise<GuidancePriority> => {
    const offering = ctx.snapshot.offerings.find((o) => o.id === offeringId)!;
    const course = ctx.snapshot.courses.find((c) => c.id === offering.courseId);
    const goals = course === undefined ? [] : (await learningGoalsFor(catalog, course)).goals;
    const goal = goals.find((g) => g.frameworkKey === input.frameworkKey && g.competencyUri === input.competencyUri);
    if (goal === undefined) {
      throw new EducateOsError("validation-failed", "That standard isn't in your district's approved standards for this course, so it can't be prioritised.");
    }
    const state = await resolve(input.frameworkKey, input.competencyUri, { code: goal.code, statement: goal.statement });
    if (state.state !== "approved") throw new EducateOsError("validation-failed", "That standard isn't currently approved for your district.");
    return { frameworkKey: input.frameworkKey, competencyUri: input.competencyUri, level: input.level, ...(input.pacing === undefined ? {} : { pacing: input.pacing }),
      ...(input.discussionPrompt === undefined ? {} : { discussionPrompt: input.discussionPrompt }), code: state.code, statement: state.statement };
  };

  const save = (record: GuidanceRecord, expected: number) => records.save(record, expected);
  const stamp = (ctx: C) => ({ by: ctx.principal.principalId, byName: nameOf(ctx, ctx.principal.principalId), at: now().toISOString() });

  // Learning recipes. A teacher's decision is the only way a recipe reaches a student.

  const recipesBody = async (ctx: C, offeringId: OfferingId): Promise<RouteResponse<"teacher.recipes">> => {
    const all = await load(offeringId);
    const klass = recipeClassOf(ctx.snapshot, offeringId);
    const settings = all.find((r): r is LearningRecipeSettings => r.type === "recipe-settings");
    const latest = latestRecipes(all);
    const entry = async (content: LearningRecipeRecord["content"], record: LearningRecipeRecord | undefined, starterId: string | undefined, origin: LearningRecipeRecord["origin"]): Promise<RouteResponse<"teacher.recipes">["entries"][number]> => {
      const check = await verifyRecipeStandard(catalog, content, klass, record?.status === "approved" ? record.pin?.releaseDigest : undefined);
      return {
        ...(record === undefined ? {} : { recipeId: record.recipeId }), ...(starterId === undefined ? {} : { starterId }),
        version: record?.version ?? 0, revision: record?.revision ?? 0, status: record?.status ?? "unreviewed",
        content, contentDigest: record?.contentDigest ?? await contentDigest(content), origin,
        standardCheck: { state: check.state, message: check.message }, audit: record?.audit ?? [],
      };
    };
    const entries: RouteResponse<"teacher.recipes">["entries"] = [];
    for (const starter of STARTER_RECIPES) {
      const record = latest.find((r) => r.origin.starterId === starter.id);
      entries.push(await entry(record?.content ?? starter.content, record, starter.id, record?.origin ?? { kind: "starter", starterId: starter.id, starterDigest: await contentDigest(starter.content) }));
    }
    for (const record of latest.filter((r) => r.origin.starterId === undefined)) entries.push(await entry(record.content, record, undefined, record.origin));
    return {
      paused: settings?.paused === true, settingsRevision: settings?.revision ?? 0, engaged: latest.length > 0 || settings !== undefined, entries,
      note: "Approved recipes are optional suggestions. They create no assignment, due date or grade, and a student's private goal is never shown here.",
    };
  };

  return {
    "teacher.recipes": async (ctx, { params }) => {
      await teacherAccess(ctx, params.offeringId, false);
      return recipesBody(ctx, params.offeringId);
    },

    "teacher.recipeSettings": async (ctx, { params, body }) => {
      await teacherAccess(ctx, params.offeringId, true);
      const current = (await load(params.offeringId)).find((r): r is LearningRecipeSettings => r.type === "recipe-settings");
      if ((current?.revision ?? 0) !== body.revision) throw guidanceConflict();
      await save({ type: "recipe-settings", id: `recipe-settings:${params.offeringId}`, scope: params.offeringId, revision: body.revision + 1, offeringId: params.offeringId, paused: body.paused, updated: stamp(ctx) }, body.revision);
      return recipesBody(ctx, params.offeringId);
    },

    "teacher.recipeDecision": async (ctx, { params, body }) => {
      await teacherAccess(ctx, params.offeringId, true);
      if (body.starterId !== undefined && body.recipeId !== undefined) throw new EducateOsError("validation-failed", "Name a starter recipe or an existing recipe, not both.");
      if (body.decision !== "approve" && body.content !== undefined) throw new EducateOsError("validation-failed", "Edited content can only be sent with an approval.");
      const starter = body.starterId === undefined ? undefined : STARTER_RECIPES.find((s) => s.id === body.starterId);
      if (body.starterId !== undefined && starter === undefined) throw notFound();
      const latest = latestRecipes(await load(params.offeringId));
      const current = body.recipeId !== undefined ? latest.find((r) => r.recipeId === body.recipeId) : starter === undefined ? undefined : latest.find((r) => r.origin.starterId === starter.id);
      if (body.recipeId !== undefined && current === undefined) throw notFound();
      if ((current?.revision ?? 0) !== body.revision) throw guidanceConflict();
      const who = stamp(ctx);
      const audit = (action: LearningRecipeRecord["audit"][number]["action"]) => ({ action, ...who, ...(body.note === undefined ? {} : { note: body.note }) });
      if (body.decision === "withdraw") {
        if (current?.status !== "approved") throw new EducateOsError("conflict", "Only an approved recipe can be withdrawn.");
        await save({ ...current, revision: current.revision + 1, status: "withdrawn", audit: [...current.audit, audit("withdrawn")] }, current.revision);
        return recipesBody(ctx, params.offeringId);
      }
      const content = body.content ?? current?.content ?? starter?.content;
      if (content === undefined) throw new EducateOsError("validation-failed", "Choose a starter or an existing recipe, or send the recipe's content.");
      const digest = await contentDigest(content);
      const starterId = starter?.id ?? current?.origin.starterId;
      const starterDigest = starter === undefined ? current?.origin.starterDigest : await contentDigest(starter.content);
      const origin: LearningRecipeRecord["origin"] = starterId === undefined || starterDigest === undefined ? { kind: "teacher" } : { kind: digest === starterDigest ? "starter" : "starter-edited", starterId, starterDigest };
      const record = (status: "approved" | "rejected", pin?: LearningRecipeRecord["pin"]): LearningRecipeRecord => ({
        type: "recipe", id: crypto.randomUUID(), scope: params.offeringId, revision: 1, offeringId: params.offeringId,
        recipeId: current?.recipeId ?? crypto.randomUUID(), version: (current?.version ?? 0) + 1, status, content, contentDigest: digest, origin,
        ...(pin === undefined ? {} : { pin }), audit: [audit(status === "approved" ? "approved" : "rejected")],
      });
      if (body.decision === "reject") {
        if (current?.status === "approved") throw new EducateOsError("conflict", "Withdraw an approved recipe instead of rejecting it.");
        if (current?.status === "rejected" && current.contentDigest === digest) throw new EducateOsError("conflict", "This recipe is already rejected.");
        await save(record("rejected"), 0);
        return recipesBody(ctx, params.offeringId);
      }
      if (current?.status === "approved" && current.contentDigest === digest) throw new EducateOsError("conflict", "This version is already approved.");
      // Approval is the only gate: the standard must already be in the release this district approved, now.
      const check = await verifyRecipeStandard(catalog, content, recipeClassOf(ctx.snapshot, params.offeringId));
      if (!check.ok) throw new EducateOsError("conflict", check.message);
      if (current?.status === "approved") await save({ ...current, revision: current.revision + 1, status: "withdrawn", audit: [...current.audit, audit("superseded")] }, current.revision);
      await save(record("approved", { competencyUri: check.node.uri, releaseVersion: check.releaseVersion, releaseDigest: check.releaseDigest }), 0);
      return recipesBody(ctx, params.offeringId);
    },

    "teacher.guidance": async (ctx, { params }) => {
      await teacherAccess(ctx, params.offeringId, false);
      return teacherBody(ctx, params.offeringId);
    },

    "teacher.guidanceAgenda": async (ctx, { params, body }) => {
      await teacherAccess(ctx, params.offeringId, true);
      const current = await agendaOf(params.offeringId);
      if ((current?.revision ?? 0) !== body.revision) throw guidanceConflict();
      const seen = new Set<string>();
      const priorities: GuidancePriority[] = [];
      for (const input of body.priorities) {
        const key = `${input.frameworkKey}\u0000${input.competencyUri}`;
        if (seen.has(key)) throw new EducateOsError("validation-failed", "A standard can be prioritised once.");
        seen.add(key);
        priorities.push(await pin(ctx, params.offeringId, input));
      }
      await save({ type: "agenda", id: `agenda:${params.offeringId}`, scope: params.offeringId, revision: body.revision + 1, offeringId: params.offeringId, priorities, updated: stamp(ctx) }, body.revision);
      return teacherBody(ctx, params.offeringId);
    },

    "teacher.guidanceEvidence": async (ctx, { params }) => {
      await teacherAccess(ctx, params.offeringId, false);
      const { rows, students } = await coverageFor(ctx, params.offeringId);
      const row = rows.find((r) => r.frameworkKey === params.frameworkKey && r.code === params.code);
      if (row === undefined) throw notFound();
      const perStudent = students.get(`${row.frameworkKey}\u0000${row.competencyUri}`)!;
      const plans = await plansOf(params.offeringId);
      return {
        row,
        students: roster(ctx, params.offeringId).map((s) => {
          const entry = perStudent.get(s.id)!;
          return {
            studentId: s.id as PrincipalId, displayName: s.displayName, state: entry.state,
            // Only what the teacher view of the planner already allows: teacher invitations and shared responses.
            evidence: entry.opportunities.map((o) => ({
              opportunityId: o.id, planId: plans.find((p) => p.opportunities.some((x) => x.id === o.id))!.id,
              source: plans.find((p) => p.opportunities.some((x) => x.id === o.id))!.source,
              task: o.task, criteria: o.contract.criteria.map((c) => c.description), decision: o.decision,
              ...(o.response === undefined ? {} : { response: o.response }), reviews: o.reviews,
            })),
          };
        }),
      };
    },

    "teacher.guidanceSuggestionReview": async (ctx, { params, body }) => {
      await teacherAccess(ctx, params.offeringId, true);
      const suggestion = (await suggestionsOf(params.offeringId)).find((s) => s.id === params.suggestionId);
      if (suggestion === undefined || !activeStudent(ctx, params.offeringId, suggestion.studentId) || !await standing(ctx, suggestion)) throw notFound();
      if (suggestion.revision !== body.revision) throw guidanceConflict();
      if (suggestion.status !== "awaiting-teacher" || !live(suggestion)) throw new EducateOsError("conflict", "This suggestion has already been handled or has expired.");
      const decision = body.decision === "share" ? "shared" as const : "declined" as const;
      await save({
        ...suggestion, revision: suggestion.revision + 1, status: decision,
        // A shared suggestion stays visible for the longer window; the clock for the family's wait is over.
        expiresAt: decision === "shared" ? new Date(Date.parse(suggestion.createdAt) + SUGGESTION_VISIBLE_DAYS * DAY).toISOString() : suggestion.expiresAt,
        review: { ...stamp(ctx), decision: body.decision, ...(body.note === undefined ? {} : { note: body.note }) },
      }, suggestion.revision);
      return teacherBody(ctx, params.offeringId);
    },

    "teacher.guidancePracticeInvite": async (ctx, { params, body }) => {
      await teacherAccess(ctx, params.offeringId, true);
      const ids = [...new Set(body.studentIds)];
      for (const id of ids) if (!activeStudent(ctx, params.offeringId, id)) throw new EducateOsError("not-found", "A student you chose is not actively enrolled in this class.");
      const authorName = nameOf(ctx, ctx.principal.principalId);
      for (const studentId of ids) {
        const id = crypto.randomUUID();
        await save({ type: "practice", id, scope: params.offeringId, revision: 1, offeringId: params.offeringId, studentId, authorId: ctx.principal.principalId, authorName, skill: body.skill,
          ...(body.note === undefined ? {} : { note: body.note }), createdAt: now().toISOString() }, 0);
      }
      return teacherBody(ctx, params.offeringId);
    },

    "student.guidance": async (ctx, { params }) => {
      await studentAccess(ctx, params.offeringId, false);
      return studentBody(ctx, params.offeringId);
    },

    "student.guidanceRespond": async (ctx, { params, body }) => {
      await studentAccess(ctx, params.offeringId, true);
      const me = ctx.principal.principalId;
      const practice = (await practiceOf(params.offeringId)).find((r) => r.id === params.invitationId && r.studentId === me);
      const suggestion = (await suggestionsOf(params.offeringId)).find((r) => r.id === params.invitationId && r.studentId === me);
      const record = practice ?? suggestion;
      if (record === undefined) throw notFound();
      if (record.revision !== body.revision) throw guidanceConflict();
      if (suggestion !== undefined && (suggestion.status !== "shared" || !live(suggestion) || !await standing(ctx, suggestion))) throw notFound();
      await save({ ...record, revision: record.revision + 1, student: { decision: body.decision, at: now().toISOString() } }, record.revision);
      return studentBody(ctx, params.offeringId);
    },

    "student.guidancePreference": async (ctx, { body }) => {
      // A student's own switch, keyed by their principal and never by anything the request names, like
      // the email preferences: there is no resource of another person's to decide on. The surface admits
      // only a student principal, and an inactive one is refused here.
      const me = ctx.principal.principalId;
      if (!ctx.snapshot.principals.some((p) => p.id === me && p.kind === "student" && p.status === "active")) throw notFound();
      const current = await preferenceOf(me);
      if ((current?.revision ?? 0) !== body.revision) throw guidanceConflict();
      const next: GuidancePreference = { type: "preference", id: `pref:${me}`, scope: `student:${me}`, revision: body.revision + 1, studentId: me, guardianSuggestions: body.guardianSuggestions, updatedAt: now().toISOString() };
      await save(next, body.revision);
      return { guardianSuggestions: next.guardianSuggestions, revision: next.revision };
    },

    "guardian.guidance": async (ctx, { params }) => guardianBody(ctx, params.studentId),

    "guardian.guidanceSuggest": async (ctx, { params, body }) => {
      const { relationships, student } = await relationshipsTo(ctx, params.studentId);
      if (!activeStudent(ctx, params.offeringId, params.studentId)) throw notFound();
      // The engine decides, as the guardian, through the administrator's explicit grant. No grant: forbidden.
      await ctx.require("create", guidanceResource(ctx, params.offeringId, params.studentId), "Your district hasn't turned on family suggestions for this class.");
      // A student who switched family suggestions off is not told to the family; the answer is the same as "not now".
      if ((await preferenceOf(params.studentId))?.guardianSuggestions === "off") throw new EducateOsError("conflict", "A suggestion can't be sent for this class right now.");
      const existing = (await suggestionsOf(params.offeringId)).filter((s) => s.guardianId === ctx.principal.principalId && s.studentId === params.studentId);
      // The cap counts what is actionable now. A suggestion withheld because its standing ended must not lock the
      // family out after a new grant; the retained bound below keeps repeated revoke/re-grant from piling records up.
      const open = existing.filter((s) => live(s) && (s.status === "awaiting-teacher" || s.status === "shared"));
      if ((await withStanding(ctx, open)).length >= MAX_OPEN_SUGGESTIONS || open.length >= MAX_RETAINED_OPEN_SUGGESTIONS) {
        throw new EducateOsError("conflict", `You have ${MAX_OPEN_SUGGESTIONS} open suggestions for this class. Withdraw one first.`);
      }
      const granted: { id: string; revision: number }[] = [];
      for (const r of relationships) {
        const grant = await stores.guidance.guardianGrants.get(r.id);
        if (grant?.enabled === true && grant.capabilities.includes("suggest")) granted.push({ id: r.id, revision: grant.revision });
      }
      const createdAt = now();
      await save({
        type: "suggestion", id: crypto.randomUUID(), scope: params.offeringId, revision: 1, offeringId: params.offeringId, studentId: student.id,
        guardianId: ctx.principal.principalId, guardianName: nameOf(ctx, ctx.principal.principalId), relationshipId: granted[0]?.id ?? relationships[0]!.id,
        ...(granted[0] === undefined ? {} : { grantRevision: granted[0].revision }), kind: body.kind, topic: body.topic, ...(body.note === undefined ? {} : { note: body.note }), status: "awaiting-teacher",
        createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + SUGGESTION_WAIT_DAYS * DAY).toISOString(),
      }, 0);
      return guardianBody(ctx, params.studentId);
    },

    "guardian.guidanceWithdraw": async (ctx, { params }) => {
      await relationshipsTo(ctx, params.studentId);
      await ctx.require("create", guidanceResource(ctx, params.offeringId, params.studentId), "Your district hasn't turned on family suggestions for this class.");
      const suggestion = (await suggestionsOf(params.offeringId)).find((s) => s.id === params.suggestionId && s.guardianId === ctx.principal.principalId && s.studentId === params.studentId);
      if (suggestion === undefined) throw notFound();
      if (suggestion.status === "withdrawn" || suggestion.status === "declined") return guardianBody(ctx, params.studentId);
      await save({ ...suggestion, revision: suggestion.revision + 1, status: "withdrawn" }, suggestion.revision);
      return guardianBody(ctx, params.studentId);
    },

    "admin.guardianGuidance": async (ctx, { params }) => {
      await ctx.require("list", adminResource(ctx), "Only a district administrator can manage guardian access.");
      return adminBody(ctx, params.studentId);
    },

    "admin.setGuardianGuidance": async (ctx, { params, body }) => {
      await ctx.require("update", adminResource(ctx), "Only a district administrator can manage guardian access.");
      const relationship = await stores.guardianRelationships.get(params.relationshipId);
      if (relationship === undefined || relationship.districtId !== ctx.principal.districtId) throw notFound();
      if (relationship.status === "revoked") throw new EducateOsError("conflict", "A revoked relationship can't be given guidance access.");
      const current = await stores.guidance.guardianGrants.get(relationship.id);
      if ((current?.revision ?? 0) !== body.revision) throw guidanceConflict();
      await stores.guidance.guardianGrants.save(nextGuardianGuidanceGrant(current, relationship, body.capabilities, ctx.principal.principalId, now()), body.revision);
      return adminBody(ctx, relationship.studentPrincipalId);
    },
  };
}
