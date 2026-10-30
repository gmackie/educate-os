// Northfield, the demo's first district: the real district application over in-memory stores,
// rostered by OneRoster and seeded as the harness seeds its districts. Imports read the harness's
// synthetic web, and no AI is funded or reviewed, so no request ever leaves for a model.
import type { DistrictApiClient } from "@educateos/api-client";
import type { PrincipalId } from "@educateos/contracts";
import { createDistrictApp, inMemoryDistrictStores } from "@educateos/district-app";
import { NORTHFIELD } from "@educateos/fixtures";
import { demoWeb, seedDistrict } from "@educateos/harness";
import { clientsOver, personaVerifier, seedRelease, verifySeedRelease, type DemoDistrict, type Persona, type PersonaId } from "./shared.ts";

/** The guardian the demo onboards for its student, who is not on the roster. */
const GUARDIAN = { subject: "nf-g-3001", displayName: "Grace Okafor" } as const;

/**
 * Who a visitor can be in Northfield, in the order the picker offers them. Known before the
 * district boots, so the picker shows at once; {@link bootNorthfield} checks the seed made them
 * the people it seeded work for.
 */
export const NORTHFIELD_PERSONAS: readonly Persona[] = [
  {
    id: "student",
    name: "Amara Okafor",
    role: "Grade 9 student",
    description: "Open English 9, write and submit an assignment, and read your teacher's feedback.",
    subject: "nf-s-2001",
  },
  {
    id: "teacher",
    name: "Sam Rivera",
    role: "English 9 teacher",
    description: "See your students' work, grade it and release feedback, and post an announcement.",
    subject: "nf-0101",
  },
  {
    id: "guardian",
    name: GUARDIAN.displayName,
    role: "Amara's guardian",
    description: "Follow your child's classes, due dates and released grades.",
    subject: GUARDIAN.subject,
  },
  {
    id: "admin",
    name: "Avery Admin",
    role: "District administrator",
    description: "Look over the district's people, classes, policies and settings.",
    subject: "nf-0001",
  },
];

/**
 * Boots Northfield and seeds it, without funding pools, a model catalog or a content reviewer: AI
 * is off, and every AI surface reports that it is not set up.
 */
export async function bootNorthfield(): Promise<DemoDistrict> {
  const directory = NORTHFIELD;
  const app = await createDistrictApp({
    stores: inMemoryDistrictStores(directory),
    verifyRequest: personaVerifier(directory),
    importFetch: demoWeb,
    verifyCatalogRelease: verifySeedRelease,
  });
  const clientFor = clientsOver((request) => app.fetch(request));
  const signInAs = async (subject: string) => clientFor(subject);

  const seeded = await seedDistrict(directory, app, signInAs);
  const subjectOf = (id: PrincipalId) => directory.principals.find((p) => p.id === id)!.externalIdentities[0]!.subject;
  const teacher = clientFor(subjectOf(seeded.teacher.id));
  const admin = clientFor(subjectOf(seeded.admin.id));

  const essay = await reviewSeededEssay(teacher);
  await submitClassmateEssay(clientFor(CLASSMATE_SUBJECT), essay);
  await addOpenAssignment(teacher, essay.offeringId);
  await onboardGuardian(admin, clientFor(GUARDIAN.subject), seeded.student.id);

  const seededAs: Record<Exclude<PersonaId, "guardian">, PrincipalId> = { student: seeded.student.id, teacher: seeded.teacher.id, admin: seeded.admin.id };
  for (const persona of NORTHFIELD_PERSONAS) {
    if (persona.id !== "guardian" && subjectOf(seededAs[persona.id]) !== persona.subject) {
      throw new Error(`the demo seed's ${persona.id} is not ${persona.name}`);
    }
  }
  return { key: "northfield", clientFor };
}

/**
 * The teacher reads the essay the seed submitted, comments, records a grade and releases both, so
 * the student has feedback to find from the start. Returns the essay's assignment.
 */
async function reviewSeededEssay(teacher: DistrictApiClient): Promise<{ offeringId: string; assignmentId: string }> {
  for (const { offering } of await teacher.call("teacher.listOfferings")) {
    for (const assignment of await teacher.call("teacher.listAssignments", { params: { offeringId: offering.id } })) {
      const [submission] = await teacher.call("teacher.listSubmissions", { params: { assignmentId: assignment.id } });
      if (submission === undefined) continue;
      const submissionId = submission.id;
      await teacher.call("teacher.addComment", {
        params: { submissionId },
        body: { body: "A clear position and a good start on evidence. Add a counterclaim and answer it in your next draft." },
      });
      await teacher.call("teacher.recordGrade", { params: { submissionId }, body: { score: { points: 8, maxPoints: 10 } } });
      await teacher.call("teacher.releaseFeedback", { params: { submissionId }, body: { state: "shared-with-student" } });
      return { offeringId: offering.id, assignmentId: assignment.id };
    }
  }
  throw new Error("the demo seed submitted no essay");
}

/** A classmate of the demo student in the essay's class (Elena Sato), whose essay waits for grading. */
const CLASSMATE_SUBJECT = "nf-s-2004";

/** The classmate submits the essay too, so the teacher has ungraded work from the start. */
async function submitClassmateEssay(classmate: DistrictApiClient, essay: { offeringId: string; assignmentId: string }): Promise<void> {
  const workspace = await classmate.call("student.openCourseWorkspace", { params: { offeringId: essay.offeringId } });
  const { artifact, head } = await classmate.call("student.createArtifact", {
    body: {
      workspaceId: workspace.id,
      type: "document",
      title: "Later start essay",
      content: {
        kind: "text",
        mediaType: "text/markdown",
        text: "The school day should not start later. Buses, sports and after-school jobs are built around the current schedule, and moving it would push everything later into the evening.",
      },
    },
  });
  await classmate.call("student.submit", { params: { assignmentId: essay.assignmentId }, body: { revisions: [{ artifactId: artifact.id, revisionId: head.id }] } });
}

/** A second writing assignment in the essay's class, still open, for the student to do in the demo. */
async function addOpenAssignment(teacher: DistrictApiClient, offeringId: string): Promise<void> {
  const params = { offeringId };
  const [release] = await teacher.call("teacher.listReleases", { params });
  const resource = { resourceId: release!.descriptor.id, version: release!.descriptor.release.version };
  const rubric = await teacher.call("teacher.signRubric", { params, body: { rubric: REFLECTION_RUBRIC } });
  // The seed approved this framework for the district.
  const ela = await seedRelease("ccss-ela");
  const draft = await teacher.call("teacher.createActivity", {
    params,
    body: {
      activity: {
        template: "writing-task",
        subject: "english-language-arts",
        gradeBand: "9",
        title: "Reading reflection",
        overview: "Reflect on a book or article you read this month.",
        prompt: "What did you read, what stayed with you, and why? Write at least a paragraph.",
        genre: "informative",
        minimumCitations: 0,
        resources: [resource],
        codex: [{ kind: "resource", resource, visibility: "students" }],
        alignments: [{ frameworkKey: "ccss-ela", competencyUri: ela.content.nodes![0]!.uri }],
        aiHelp: "none",
        due: { kind: "after-install", days: 7 },
      },
    },
  });
  await teacher.call("teacher.publishActivity", { params: { definitionId: draft.id } });
  await teacher.call("teacher.installActivity", {
    params: { definitionId: draft.id },
    body: { offeringId, assignment: { rubric: { rubricId: rubric.rubricId, version: rubric.version } } },
  });
}

const REFLECTION_RUBRIC = {
  rubricId: "rbr_demo-reflection",
  version: 1,
  title: "Reflection",
  criteria: [{
    id: "reflection",
    title: "Reflection",
    levels: [{ id: "beginning", label: "Beginning", points: 1 }, { id: "developing", label: "Developing", points: 3 }, { id: "thoughtful", label: "Thoughtful", points: 5 }],
    checks: [],
  }],
};

/**
 * Onboards the student's guardian the way a district does (ADR-0012): the administrator invites
 * them, they redeem the invitation, and the administrator approves their sign-in and confirms
 * the relationship.
 */
async function onboardGuardian(admin: DistrictApiClient, guardian: DistrictApiClient, studentId: PrincipalId): Promise<void> {
  const invited = await admin.call("admin.inviteGuardian", { params: { studentId }, body: { guardianDisplayName: GUARDIAN.displayName } });
  const token = new URLSearchParams(new URL(invited.invitationUrl).hash.slice(1)).get("invitation")!;
  await guardian.call("onboarding.redeemGuardianInvitation", { body: { token } });
  const { pendingSignIns } = await admin.call("admin.studentGuardians", { params: { studentId } });
  const signIn = pendingSignIns.find((p) => p.invitationId === invited.invitation.id)!;
  await admin.call("admin.approveIdentityRequest", { params: { requestId: signIn.requestId } });
  await admin.call("admin.confirmGuardian", { params: { relationshipId: invited.relationship.id } });
}
