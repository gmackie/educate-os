import { beforeAll, describe, expect, it, vi } from "vitest";
import { cleverSideOf } from "../clever/cleverSide.ts";
import { cleverFor, instantLogin } from "../clever/instantLogin.ts";
import { bootCedarValley, type CedarValleyDistrict } from "../districts/cedarvalley.ts";
import { CEDARVALLEY_PERSONAS } from "../districts/cedarvalleyPersonas.ts";
import type { PersonaId } from "../districts/index.ts";
import { CLEVER_TOUR_STEPS, CleverTourStore, jumpTo, showMe, type TourActions, type TourStepId } from "./cleverTour.ts";

const subjectOf = (id: PersonaId) => CEDARVALLEY_PERSONAS.find((p) => p.id === id)!.subject;
const step = (id: TourStepId) => CLEVER_TOUR_STEPS.find((s) => s.id === id)!;

/**
 * A booted Cedar Valley with a tour wired to it as the demo wires one: the roster's syncs, the
 * Clever side's changes and the passback gate's events, and a client for `persona` whose requests
 * the tour sees, signed in through Instant Login as the portal signs them in.
 */
async function touring() {
  const district = await bootCedarValley();
  const tour = new CleverTourStore();
  district.roster.onSync((result) => tour.synced(result));
  cleverSideOf(district)!.onChange((change) => tour.cleverChanged(change));
  district.grades.subscribe((event) => event !== undefined && tour.graded(event));
  const signIn = async (persona: PersonaId) => {
    tour.tileClicked(persona);
    const result = await instantLogin(cleverFor(district), subjectOf(persona), district, { onHop: (hop) => tour.hop(hop) });
    if (result.outcome !== "signed-in") throw new Error(result.reason);
    tour.signedIn(persona);
    return district.clientFor(result.session, (request, response) => tour.responded(persona, request, response.status));
  };
  return { district, tour, signIn, done: () => [...tour.getSnapshot().done] };
}

describe("the Clever tour, step by step, against a booted Cedar Valley", () => {
  let world: Awaited<ReturnType<typeof touring>>;
  let district: CedarValleyDistrict;
  beforeAll(async () => {
    world = await touring();
    district = world.district;
  });

  it("starts at the portal, with nothing done", () => {
    expect(world.tour.getSnapshot().current?.id).toBe("portal");
    expect(world.done()).toEqual([]);
  });

  it("1 and 2: opening EducateOS from the portal as Elaine Park, then her Clever sign-in", async () => {
    const admin = await world.signIn("admin");
    expect(world.done()).toEqual(["portal", "sign-in"]);
    const { facts } = world.tour.getSnapshot();
    expect(facts).toMatchObject({ signedInAs: "admin", identityChecked: true });
    expect(step("sign-in").explain(facts)).toContain("verified it, and matched it to Cedar Valley's Clever district");
    // The first sync, run from the Roster sync screen's own call.
    await admin.call("admin.runRosterSync", { body: { mode: "complete" } });
  });

  it("3: the first complete sync, explained with what it really brought in", async () => {
    expect(world.done()).toContain("first-sync");
    const { firstSync } = world.tour.getSnapshot().facts;
    const { runs } = await district.clientFor(district.sessions.start({ issuer: district.cleverSso.issuer, subject: subjectOf("admin"), credential: "person" })).call("admin.rosterSyncStatus");
    const counts = runs.find((run) => run.mode === "complete")!.counts;
    expect(firstSync).toEqual({ people: counts.principals.added, classes: counts.offerings.added, schools: counts.schools.added, enrollments: counts.enrollments.added });
    expect(firstSync).toMatchObject({ people: 8, classes: 4 });
    expect(step("first-sync").explain(world.tour.getSnapshot().facts)).toMatch(/^The complete sync brought in 8 people, 4 classes, \d+ schools? and \d+ enrollments?\.$/);
    expect(world.tour.getSnapshot().current?.id).toBe("clever-change");
  });

  it("does not count a delta sync before anything changed in Clever", async () => {
    await world.signIn("admin").then((admin) => admin.call("admin.runRosterSync", { body: { mode: "delta" } }));
    expect(world.done()).not.toContain("delta-sync");
  });

  it("4 and 5: a change on the Clever side, then the delta sync that brings it in", async () => {
    const side = cleverSideOf(district)!;
    const bao = side.getSnapshot().sections.flatMap((s) => s.students).find((s) => s.name === "Bao Nguyen")!;
    side.withdraw(bao.id);
    expect(world.done()).toContain("clever-change");
    const admin = await world.signIn("admin");
    await admin.call("admin.runRosterSync", { body: { mode: "delta" } });
    expect(world.done()).toContain("delta-sync");
    expect(world.tour.getSnapshot().facts.delta).toEqual({ added: 0, updated: 0, deactivated: 1 });
  });

  it("6 and 7: Dana grades An Nguyen's work, and the grade lands in the class's gradebook", async () => {
    const teacher = await world.signIn("teacher");
    const offerings = await teacher.call("teacher.listOfferings");
    const earthScience = offerings.find(({ course }) => course.title === "Earth Science 8")!.offering.id;
    const [assignment] = await teacher.call("teacher.listAssignments", { params: { offeringId: earthScience } });
    const [submission] = await teacher.call("teacher.listSubmissions", { params: { assignmentId: assignment!.id } });
    // A refused grade is not the tour's last step.
    await district.grades.tryUnapproved(earthScience);
    expect(world.done()).not.toContain("grade-out");

    await teacher.call("teacher.recordGrade", { params: { submissionId: submission!.id }, body: { score: { points: 4, maxPoints: 5 } } });
    expect(world.done()).toContain("teacher-grade");
    expect(world.done()).toContain("grade-out");
    const snapshot = world.tour.getSnapshot();
    expect(snapshot.facts.landedIn).toBe("google-classroom");
    expect(snapshot.current).toBeUndefined();
    expect(step("grade-out").explain(snapshot.facts)).toContain("The grade landed in the simulated Google Classroom");
  });
});

describe("the tour's steps", () => {
  it("count only what they say: Elaine's tile, an official grade, a sent grade", () => {
    const tour = new CleverTourStore();
    tour.tileClicked("teacher");
    expect(tour.getSnapshot().done.has("portal")).toBe(false);
    const grade = { method: "POST", url: "https://district.demo.educateos.invalid/api/teacher/submissions/sub_1/grade" };
    tour.responded("student", grade, 200);
    tour.responded("teacher", grade, 403);
    expect(tour.getSnapshot().done.has("teacher-grade")).toBe(false);
    // Sharing feedback or saving a rubric score sends no grade anywhere, so neither counts.
    tour.responded("teacher", { method: "POST", url: "https://district.demo.educateos.invalid/api/teacher/submissions/sub_1/feedback/release" }, 200);
    tour.responded("teacher", { method: "POST", url: "https://district.demo.educateos.invalid/api/teacher/submissions/sub_1/scores" }, 200);
    expect(tour.getSnapshot().done.has("teacher-grade")).toBe(false);
    tour.responded("teacher", grade, 200);
    expect(tour.getSnapshot().done.has("teacher-grade")).toBe(true);
  });

  it("make no claim about Clever beyond the demo's: simulated, and LMS Connect untested against Clever", () => {
    const copy = CLEVER_TOUR_STEPS.map((s) => s.explain({})).join(" ");
    expect(copy).toContain("simulated");
    expect(copy).toContain("built to Clever's published v3.1 API and not tested against Clever");
    expect(copy).not.toMatch(/certified|partner|approved by Clever|connected to Clever/i);
  });
});

/** Tour actions that record what they were asked to do. */
const actions = () => {
  const calls: string[] = [];
  const a: TourActions = {
    openPortalAs: vi.fn((persona) => void calls.push(`portal ${persona}`)),
    openApp: vi.fn((persona, options) => void calls.push(`app ${persona} ${JSON.stringify(options ?? {})}`)),
    openCleverSide: vi.fn(() => void calls.push("clever-side")),
    teacherClassRoute: vi.fn(async () => "#/classes/off_1/submissions"),
    ensureFirstSync: vi.fn(async () => void calls.push("first-sync")),
  };
  return { a, calls };
};

describe("Show me and presenter mode's jump", () => {

  it("Show me stops at the portal for the sign-in steps and opens the app for the rest", async () => {
    const { a, calls } = actions();
    for (const s of CLEVER_TOUR_STEPS) await showMe(s.id, a);
    expect(calls).toEqual([
      "portal admin",
      "portal admin",
      'app admin {"route":"#/roster-sync"}',
      "clever-side",
      'app admin {"route":"#/roster-sync"}',
      'app teacher {"route":"#/classes/off_1/submissions"}',
      'app teacher {"route":"#/classes/off_1/submissions","grades":true}',
    ]);
    expect(a.ensureFirstSync).not.toHaveBeenCalled();
  });

  it("a jump past the first sync runs it first, then signs in through the portal", async () => {
    const { a, calls } = actions();
    await jumpTo("teacher-grade", a);
    expect(calls).toEqual(["first-sync", 'app teacher {"route":"#/classes/off_1/submissions"}']);
  });

  it("a jump to the portal or the first sync leaves them for the presenter to do", async () => {
    const { a, calls } = actions();
    await jumpTo("portal", a);
    await jumpTo("first-sync", a);
    expect(calls).toEqual(["portal admin", 'app admin {"route":"#/roster-sync"}']);
  });
});
