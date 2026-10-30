// Grade passback in the demo (SCHO-278): a teacher's approved grades go out through the real
// passback gate (`GradePassback` from @educateos/lti) to a gradebook running in the page, either
// Google Classroom directly or the LMS behind Clever through Clever LMS Connect, as each class's
// route says. The gate reads its approvals from the district's own official grade versions
// (`OfficialGradeApprovals`), exactly as the district Worker's LTI passback does, so nothing here
// decides whether a grade may go: the gate does, and its refusals are shown as it gave them.
//
// The district application routes no grade passback itself (the Worker composes it for LTI in
// src/lti.ts), so the demo composes it here, as the pilot gate does for a Clever-rostered district
// whose LMS is Classroom: Classroom courses linked to the roster's offerings by alias, and Google
// accounts to people by name, every name match accepted in bulk where production needs an
// administrator to confirm each one.
import { CLASSROOM_ISSUER, ClassroomAdapter, ClassroomGradeSink, CleverLmsConnectAdapter, CleverLmsConnectClient, CleverLmsConnectGradeSink, GradePassback, InMemoryPassbackLedger, type ClassroomGradeRoute, type CleverLmsConnectGradeRoute, type GradePassbackRequest, type GradeRoute, type GradeRouteStore } from "@educateos/lti";
import { InMemoryRecordTable, OfficialGradeApprovals, TableGradeColumnStore, type GradeColumnBinding, type GradeColumnStore } from "@educateos/lti-district";
import { DistrictDirectorySnapshot, EducateOsError, type GradeAuthority, type OfferingId, type PrincipalId } from "@educateos/contracts";
import type { DistrictAppStores } from "@educateos/district-app";
import { classroomSeed, districtSeed, type DemoDistrict as FixtureDistrict } from "@educateos/fixtures";
import { googleclassroom, RosterSyncError } from "@educateos/integrations";
import { GoogleClassroomFake, type CleverDataFake, type DistrictSeed } from "@educateos/provider-fakes";
import type { ClassroomLanding, CleverLanding, DemoGradebooks, GradeClass, GradeEvent, GradeRouteKind } from "./types.ts";

/** What the demo's gradebooks are built from. */
export interface DemoGradebooksOptions {
  /** The district's fixture, which the Classroom fake is seeded from. */
  fixture: FixtureDistrict;
  /** The district application's stores: its directory, its roster's source map and its official grades. */
  stores: Pick<DistrictAppStores, "directory" | "rosterSources" | "assessment">;
  /** The Clever district the roster comes from, whose LMS Connect gradebook is one of the two routes. */
  clever: CleverDataFake;
  /** The issuer of the district's Clever identities, whose subjects are Clever user IDs. */
  cleverIssuer: string;
  /** The grade authority both routes record: the district's LMS, which LMS Connect also writes into. */
  authority: Exclude<GradeAuthority, "local">;
}

/** The demo's gradebooks, and the hook the district calls after each request. */
export interface DemoGradebooksHandle extends DemoGradebooks {
  /**
   * Hands every official grade version not yet seen to the passback gate, one at a time. Called
   * once each request that may have approved a grade has returned. Never throws: what the gate
   * refuses is recorded as a refused event.
   */
  deliverNewGrades(): Promise<void>;
  /** The Classroom fake, for reading back what landed there. */
  readonly classroom: GoogleClassroomFake;
}

/** Who and what a passback attempt is about. */
interface Attempt {
  offeringId: string;
  studentId: string;
  assignmentId?: string;
  scoreGiven: number;
  scoreMaximum: number;
  gradeVersion: number;
}

const versionKey = (v: { assignmentId: string; studentPrincipalId: string; version: number }) => JSON.stringify([v.assignmentId, v.studentPrincipalId, v.version]);

/** Builds the demo's two gradebooks and the passback gate in front of them. */
export function createDemoGradebooks(options: DemoGradebooksOptions): DemoGradebooksHandle {
  const { stores, clever, authority } = options;
  const districtId = options.fixture.directory.district.id;
  const classroomWorld = classroomFake(options.fixture);
  const { fake: classroom, client: classroomClient } = classroomWorld;
  const provider = new googleclassroom.GoogleClassroomProvider(classroomClient);
  const cleverClient = new CleverLmsConnectClient({ fetch: clever.fetch, token: async () => clever.districtToken });

  // Every class starts on the district's own LMS, Classroom, as its fixture says.
  const choices = new Map<string, GradeRouteKind>();
  const routeOf = (offeringId: string): GradeRouteKind => choices.get(offeringId) ?? "google-classroom";
  const routes: GradeRouteStore = {
    async routeFor(offeringId) {
      return (await routesOf(offeringId))[routeOf(offeringId)];
    },
  };

  // Classroom's courses and accounts are linked as the roster stands, planned again only when a
  // sync has changed who or what is in it, and reapplied to the directory on every read.
  let links: { key: string; plan: Promise<googleclassroom.ClassroomLinkPlan> } | undefined;
  const linkPlan = (directory: DistrictDirectorySnapshot) => {
    const key = JSON.stringify([directory.offerings.map((o) => o.id), directory.enrollments.map((e) => [e.id, e.status])]);
    if (links?.key !== key) {
      const plan = (async () => {
        const seedOf = await seedSectionsByOffering();
        const aliasesOf = (offeringId: OfferingId) => {
          const seedId = seedOf.get(offeringId);
          return seedId === undefined ? [] : [`d:${seedId}`];
        };
        return googleclassroom.planClassroomLinks({ directory, client: classroomClient, aliasesOf });
      })();
      links = { key, plan };
      plan.catch(() => links?.plan === plan && (links = undefined));
    }
    return links!.plan;
  };
  /** The directory with the Classroom links applied, and the Classroom routes they make, as the gate reads them. */
  const linkedDirectory = async () => {
    const directory = (await stores.directory.load()).snapshot;
    const plan = await linkPlan(directory);
    const trusting = DistrictDirectorySnapshot.parse({
      ...directory,
      district: { ...directory.district, trustedIssuers: [...new Set([...directory.district.trustedIssuers, CLASSROOM_ISSUER])] },
    });
    return googleclassroom.applyClassroomLinks({ directory: trusting, courses: plan.courses, identities: plan.identities, authority, acceptNameMatches: true });
  };

  /** Each Clever section's seed ID, by the offering the roster made of it. */
  const seedSectionsByOffering = async () => {
    const bySectionId = new Map(clever.seed.sections.map((s) => [clever.idOf("sections", s.id), s.id]));
    const sources = await stores.rosterSources.load();
    return new Map(Object.entries(sources.offerings).flatMap(([offeringId, sectionId]) => {
      const seedId = bySectionId.get(sectionId);
      return seedId === undefined ? [] : [[offeringId, seedId] as const];
    }));
  };

  /** The offering's route through each gradebook. */
  const routesOf = async (offeringId: string): Promise<Partial<Record<GradeRouteKind, GradeRoute>>> => {
    const sectionId = (await stores.rosterSources.load()).offerings[offeringId as OfferingId];
    if (sectionId === undefined) return {};
    const { routes: classroomRoutes } = await linkedDirectory();
    const cleverRoute: CleverLmsConnectGradeRoute = { offeringId: offeringId as OfferingId, authority, via: "clever-lms-connect", districtId: clever.districtId, sectionId };
    const classroomRoute: ClassroomGradeRoute | undefined = classroomRoutes.find((r) => r.offeringId === offeringId);
    return { "clever-lms-connect": cleverRoute, ...(classroomRoute === undefined ? {} : { "google-classroom": classroomRoute }) };
  };

  // One column store per gradebook: lti-district's store binds an assignment to one column only,
  // so a class switched to the other route needs that gradebook's column bound beside it.
  const columnStores: Record<GradeRouteKind, GradeColumnStore> = {
    "google-classroom": new TableGradeColumnStore(new InMemoryRecordTable()),
    "clever-lms-connect": new TableGradeColumnStore(new InMemoryRecordTable()),
  };
  // The gate only reads columns; each is bound in its own gradebook's store.
  const columns: GradeColumnStore = {
    bind: () => Promise.reject(new Error("bind a column in its gradebook's own store")),
    async assignmentFor(offeringId, column) {
      return (await columnStores["google-classroom"].assignmentFor(offeringId, column)) ?? columnStores["clever-lms-connect"].assignmentFor(offeringId, column);
    },
  };
  const columnIds = new Map<string, string>();
  const classroomAdapter = new ClassroomAdapter({ districtId, provider, routes });
  const cleverAdapter = new CleverLmsConnectAdapter({ client: cleverClient, routes });

  /** The column in the class's current gradebook for an assignment, created out of `maxPoints` the first time. */
  const columnFor = async (via: GradeRouteKind, offeringId: OfferingId, assignment: { id: GradeColumnBinding["assignmentId"]; title: string }, maxPoints: number): Promise<string> => {
    const key = JSON.stringify([via, offeringId, assignment.id]);
    const known = columnIds.get(key);
    if (known !== undefined) return known;
    const column = via === "google-classroom"
      ? (await classroomAdapter.createCourseWork(offeringId, { title: assignment.title, maxPoints })).id
      : (await cleverAdapter.createAssignment(offeringId, { title: assignment.title, pointsPossible: maxPoints })).id;
    await columnStores[via].bind({ offeringId, column, assignmentId: assignment.id });
    columnIds.set(key, column);
    return column;
  };

  const passback = new GradePassback({
    districtId,
    directory: async () => (await linkedDirectory()).directory,
    routes,
    approvals: new OfficialGradeApprovals({ districtId, columns, assessments: stores.assessment }),
    ledger: new InMemoryPassbackLedger(),
    sinks: [new ClassroomGradeSink(provider), new CleverLmsConnectGradeSink({ client: cleverClient, issuer: options.cleverIssuer })],
  });

  let events: readonly GradeEvent[] = [];
  const sent = new Map<string, { request: GradePassbackRequest; about: Attempt }>();
  const listeners = new Set<(event?: GradeEvent) => void>();
  const notify = (event?: GradeEvent) => {
    for (const listener of listeners) listener(event);
  };

  /**
   * Sends one request through the gate and records what happened, reading back what landed. The
   * request may be built on the way (creating its column), and a failure there is recorded too.
   */
  const attempt = async (about: Attempt, build: (via: GradeRouteKind) => Promise<GradePassbackRequest>): Promise<GradeEvent> => {
    const via = routeOf(about.offeringId);
    const directory = (await stores.directory.load()).snapshot;
    const offering = directory.offerings.find((o) => o.id === about.offeringId);
    const { state } = await stores.assessment.load();
    const base = {
      id: `grade-${events.length + 1}`,
      at: new Date().toISOString(),
      offeringId: about.offeringId,
      className: directory.courses.find((c) => c.id === offering?.courseId)?.title ?? "a class",
      studentName: directory.principals.find((p) => p.id === about.studentId)?.displayName ?? "a student",
      assignmentTitle: state.assignments.find((a) => a.id === about.assignmentId)?.title ?? "an assignment",
      scoreGiven: about.scoreGiven,
      scoreMaximum: about.scoreMaximum,
      gradeVersion: about.gradeVersion,
      via,
    };
    let event: GradeEvent;
    let request: GradePassbackRequest | undefined;
    try {
      request = await build(via);
      const result = await passback.publish(request);
      // The gate has only the two sinks, so it reports one of their routes.
      const route = result.route as GradeRouteKind;
      event = { ...base, via: route, outcome: result.status, landed: await landing(route, request) };
    } catch (error) {
      const { code, message } = error instanceof EducateOsError ? error : { code: "unavailable", message: error instanceof Error ? error.message : "The grade could not be sent." };
      event = { ...base, outcome: "refused", code, reason: message };
    }
    events = [...events, event];
    if (request !== undefined) sent.set(event.id, { request, about });
    notify(event);
    return event;
  };

  /** What the gradebook holds now for the request's column and student. */
  const landing = async (via: GradeRouteKind, request: GradePassbackRequest): Promise<ClassroomLanding | CleverLanding> => {
    const route = (await routesOf(request.offeringId))[via] as ClassroomGradeRoute | CleverLmsConnectGradeRoute;
    const { directory } = await linkedDirectory();
    const student = directory.principals.find((p) => p.id === request.studentId)!;
    if (route.via === "google-classroom") {
      const work = classroom.courseWorkOf(route.courseId).find((w) => w["id"] === request.column) ?? {};
      const subject = student.externalIdentities.find((i) => i.issuer === CLASSROOM_ISSUER)?.subject;
      const person = classroomWorld.seed.people.find((p) => classroom.userId(p.id) === subject);
      const submission = person === undefined ? undefined : classroom.submission(classroom.submissionId(request.column, person.id));
      const section = classroomWorld.seed.sections.find((s) => classroom.courseId(s.id) === route.courseId);
      return {
        via: route.via,
        courseId: route.courseId,
        courseName: [section?.title, section?.section].filter(Boolean).join(", "),
        courseWorkId: request.column,
        courseWorkTitle: String(work["title"] ?? ""),
        assignedGrade: typeof submission?.["assignedGrade"] === "number" ? submission["assignedGrade"] : undefined,
        maxPoints: typeof work["maxPoints"] === "number" ? work["maxPoints"] : undefined,
      };
    }
    const assignment = clever.assignmentsFor(route.sectionId).find((a) => a.id === request.column);
    const userId = student.externalIdentities.find((i) => i.issuer === options.cleverIssuer)?.subject ?? "";
    return {
      via: "clever-lms-connect",
      sectionId: route.sectionId,
      sectionName: String(clever.record("sections", route.sectionId)?.["name"] ?? ""),
      assignmentId: request.column,
      assignmentTitle: assignment?.title ?? "",
      gradePoints: clever.submissionFor(route.sectionId, request.column, userId)?.grade_points,
      pointsPossible: assignment?.points_possible ?? null,
    };
  };

  const seen = new Set<string>();
  let delivering = Promise.resolve();
  const deliverNewGrades = async () => {
    const { state } = await stores.assessment.load();
    for (const version of state.gradeVersions) {
      const key = versionKey(version);
      if (seen.has(key)) continue;
      seen.add(key);
      const assignment = state.assignments.find((a) => a.id === version.assignmentId)!;
      const about = { offeringId: version.offeringId, studentId: version.studentPrincipalId, assignmentId: version.assignmentId, scoreGiven: version.score.points, scoreMaximum: version.score.maxPoints, gradeVersion: version.version };
      await attempt(about, async (via) => ({
        offeringId: version.offeringId,
        studentId: version.studentPrincipalId,
        column: await columnFor(via, version.offeringId, assignment, version.score.maxPoints),
        gradeVersion: version.version,
        scoreGiven: version.score.points,
        scoreMaximum: version.score.maxPoints,
      }));
    }
  };

  return {
    classroom,
    // One delivery at a time, so two requests returning together cannot both claim a version.
    deliverNewGrades: () => (delivering = delivering.then(deliverNewGrades, deliverNewGrades)),

    async classes(): Promise<GradeClass[]> {
      const directory = (await stores.directory.load()).snapshot;
      const sources = await stores.rosterSources.load();
      const name = new Map(directory.principals.map((p) => [p.id, p.displayName]));
      return directory.offerings
        .filter((o) => sources.offerings[o.id] !== undefined)
        .map((o) => ({
          offeringId: o.id,
          title: directory.courses.find((c) => c.id === o.courseId)?.title ?? o.id,
          section: o.sectionName,
          teachers: directory.enrollments.filter((e) => e.offeringId === o.id && e.status === "active" && e.role === "teacher").map((e) => name.get(e.principalId) ?? ""),
          route: routeOf(o.id),
        }))
        .toSorted((a, b) => a.title.localeCompare(b.title));
    },

    setRoute(offeringId, route) {
      choices.set(offeringId, route);
      notify();
    },

    events: () => events,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async resend(eventId) {
      const attempted = sent.get(eventId);
      if (attempted === undefined) throw new Error(`no grade ${eventId} to send again`);
      return attempt(attempted.about, async () => attempted.request);
    },

    async tryUnapproved(offeringId) {
      const directory = (await stores.directory.load()).snapshot;
      const studentId = directory.enrollments.find((e) => e.offeringId === offeringId && e.status === "active" && e.role === "student")?.principalId;
      if (studentId === undefined) throw new Error(`no student in ${offeringId}`);
      const { state } = await stores.assessment.load();
      const assignment = state.assignments.find((a) => a.offeringId === offeringId);
      const via = routeOf(offeringId);
      // A column this class already sends to, if it has one; the gate looks for the approval
      // before it touches the gradebook, so the request never reaches either fake.
      const column = (assignment === undefined ? undefined : columnIds.get(JSON.stringify([via, offeringId, assignment.id]))) ?? assignment?.id ?? "unapproved";
      const latest = state.gradeVersions.filter((v) => v.assignmentId === assignment?.id && v.studentPrincipalId === studentId).at(-1);
      const maximum = latest?.score.maxPoints ?? 5;
      const request = { offeringId: offeringId as OfferingId, studentId: studentId as PrincipalId, column, gradeVersion: (latest?.version ?? 0) + 1, scoreGiven: maximum, scoreMaximum: maximum };
      return attempt({ ...request, ...(assignment === undefined ? {} : { assignmentId: assignment.id }) }, async () => request);
    },
  };
}

/**
 * The district as the Google Classroom fake serves it, as the pilot gate seeds it: `districtSeed`
 * narrowed by the fixtures' `classroomSeed`. Each staff member and student has a Workspace account
 * on its own domain, and each active offering with a lead teacher is a course aliased
 * `d:<offering ID>`. The client acts through domain-wide delegation as the Workspace administrator.
 */
function classroomFake(fixture: FixtureDistrict) {
  const base = districtSeed(fixture);
  const workspace = classroomSeed(fixture, `${fixture.slug}.gedu.example`);
  const accounts = new Map(workspace.users.map((u) => [u.fixtureId, u]));
  const courses = new Map(workspace.courses.map((c) => [c.fixtureId, c]));
  const seed: DistrictSeed = {
    ...base,
    domain: workspace.domain,
    people: base.people.filter((p) => accounts.has(p.id)).map((p) => ({ ...p, email: accounts.get(p.id)!.primaryEmail })),
    sections: base.sections.filter((s) => courses.has(s.id)).map((s) => {
      const course = courses.get(s.id)!;
      return { ...s, title: course.name, section: course.section, aliases: [course.alias] };
    }),
  };
  const fake = new GoogleClassroomFake({ seed });
  const tokens = new Map<string, string>();
  const delegation: googleclassroom.DelegatedTokens = {
    async token(subject) {
      const cached = tokens.get(subject);
      if (cached !== undefined) return cached;
      const person = seed.people.find((p) => p.email === subject);
      if (person === undefined) throw new RosterSyncError("auth-failed", "no such Workspace user");
      const token = fake.issueToken({ userId: person.id, scopes: [...googleclassroom.CLASSROOM_GRADE_SCOPES] });
      tokens.set(subject, token);
      return token;
    },
    invalidate(subject, token) {
      if (tokens.get(subject) === token) tokens.delete(subject);
    },
  };
  const admin = seed.people.find((p) => p.role === "administrator")!.email!;
  // The fake answers at once, so a retry has nothing to wait for.
  const client = new googleclassroom.GoogleClassroomClient({ tokens: delegation, admin, fetch: fake.fetch, sleep: async () => {} });
  return { seed, fake, client };
}
