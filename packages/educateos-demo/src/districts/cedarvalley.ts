// Cedar Valley, the demo's Clever district (SCHO-275): the real district application over in-memory
// stores, rostered by its real Clever roster sync from a Clever Data API fake running in the page.
// It boots unrostered, with only its administrator and the roster's service principal, so the first
// sync is something the visitor does. The demo loads this module only when a visitor opens Cedar
// Valley, so Northfield's visitors never download the fakes.
import type { DistrictApiClient } from "@educateos/api-client";
import { DistrictDirectorySnapshot, PrincipalId, type VerifiedIdentity } from "@educateos/contracts";
import { createDistrictApp, inMemoryDistrictStores, type RosterSourceFactory } from "@educateos/district-app";
import { CEDARVALLEY, demoDistrict, districtSeed } from "@educateos/fixtures";
import { demoWeb } from "@educateos/harness";
import { clever } from "@educateos/integrations";
import { CleverDataFake } from "@educateos/provider-fakes";
import { CEDARVALLEY_PERSONAS, CEDARVALLEY_PRINCIPALS } from "./cedarvalleyPersonas.ts";
import { clientsOver, demoSessions, verifySeedRelease, type DemoDistrict, type DemoRoster, type DemoSessions, type RosterSyncResult } from "./shared.ts";

/** The booted Cedar Valley, with the Clever district its roster comes from. */
export interface CedarValleyDistrict extends DemoDistrict {
  key: "cedarvalley";
  roster: DemoRoster;
  /**
   * The Clever district the roster sync reads, in the page. What changes here (a person added or
   * removed, a fault injected) the district sees on its next sync, as it would from Clever.
   */
  clever: CleverDataFake;
  /**
   * Who the district accepts a Clever sign-in from: its Clever district, and the issuer its
   * people's identities are linked under (`identityFromCleverClaims`' config).
   */
  cleverSso: { districtId: string; issuer: string };
  /**
   * The district's sessions. Its requests carry one of these, never a bare subject: the demo's
   * Clever Instant Login (`src/clever/instantLogin.ts`) starts one once it has verified a Clever
   * sign-in, as a district's Cloudflare Access application does.
   */
  sessions: DemoSessions;
}

const subjectOf = (id: keyof typeof CEDARVALLEY_PRINCIPALS) => CEDARVALLEY_PERSONAS.find((p) => p.id === id)!.subject;

const D = CEDARVALLEY.district.id;
const IDP = CEDARVALLEY.district.trustedIssuers[0]!;
const ADMIN = PrincipalId.parse("prn_cv-district-admin");
const SERVICE = PrincipalId.parse("prn_cv-roster-service");

/** Cedar Valley before its roster: the district, its administrator and the roster's service principal. */
const BEFORE_ROSTER = DistrictDirectorySnapshot.parse({
  district: CEDARVALLEY.district,
  schools: [],
  terms: [],
  courses: [],
  offerings: [],
  principals: [
    // Signed in by the Clever user ID the roster will carry, so the sync links the roster's Elaine
    // Park to this one rather than adding a second.
    { ...CEDARVALLEY.principals.find((p) => p.id === ADMIN)!, externalIdentities: [{ districtId: D, issuer: IDP, subject: subjectOf("admin") }] },
    { id: SERVICE, districtId: D, kind: "service", status: "active", displayName: "Roster sync", externalIdentities: [{ districtId: D, issuer: IDP, subject: "svc-roster-sync" }] },
  ],
  enrollments: [],
  roleAssignments: [
    { principalId: ADMIN, role: "district-admin", scope: { level: "district", districtId: D }, source: "local-grant" },
    { principalId: SERVICE, role: "district-admin", scope: { level: "district", districtId: D }, source: "local-grant" },
  ],
});

/** The district's configuration: rostered by Clever, applied automatically, people matched on their Clever user IDs. */
const config = (cleverDistrictId: string): Record<string, unknown> => ({
  apiVersion: "educateos.io/v1alpha1",
  district: D,
  profile: "us-k12-conservative",
  identity: { provider: "cloudflare-access" },
  rostering: {
    provider: "clever",
    mode: "apply-automatically",
    identityMapping: { issuer: IDP, subject: clever.CLEVER_SUBJECT_FIELD },
    schedule: { deltaEveryMinutes: 15, completeEveryHours: 24 },
    clever: { districtId: cleverDistrictId },
  },
  modules: { "core-learning": "enabled" },
  rollout: { target: "all-active-offerings", requiresAdminActivation: false },
});

/** A Cedar Valley person's identity, by their Clever user ID. */
const identityOf = (subject: string): VerifiedIdentity => ({ issuer: IDP, subject, credential: "person" });

const ROSTER_SYNC_PATH = "/api/admin/roster/sync";
/** A classmate of the demo student in Earth Science 8 (An Nguyen), by Clever user ID, whose work waits for grading. */
const CLASSMATE_SUBJECT = "73368fa79029d87a733690a7";

/**
 * Boots Cedar Valley unrostered, configured to roster from an in-page Clever district built from
 * the same fixture. AI is off, as in every demo district. Once a sync succeeds for the first time,
 * however it was run, the demo's teacher posts an assignment and a classmate submits it, so the
 * teacher and the student have work waiting when the visitor switches to them.
 */
export async function bootCedarValley(): Promise<CedarValleyDistrict> {
  const fake = new CleverDataFake({ seed: districtSeed(demoDistrict("cedarvalley")) });
  const rosterSource: RosterSourceFactory = (rostering) => {
    if (rostering.provider !== "clever" || rostering.clever === undefined) return { reason: "not a Clever roster" };
    // The fake answers at once, so a retry has nothing to wait for.
    const client = new clever.CleverDataClient({ connection: rostering.clever, token: fake.districtToken, fetch: fake.fetch, sleep: async () => {} });
    return { source: clever.cleverRosterSource(client) };
  };
  const sessions = demoSessions();
  const app = await createDistrictApp({
    stores: inMemoryDistrictStores(BEFORE_ROSTER),
    verifyRequest: sessions.verifyRequest,
    importFetch: demoWeb,
    verifyCatalogRelease: verifySeedRelease,
    authority: "clever",
    rosterSource,
    rosterServicePrincipalId: SERVICE,
  });

  let synced = false;
  let seeding: Promise<void> | undefined;
  const fetch = async (request: Request): Promise<Response> => {
    const response = await app.fetch(request);
    if (!synced && response.ok && request.method === "POST" && new URL(request.url).pathname === ROSTER_SYNC_PATH) {
      const result = await response.clone().json() as RosterSyncResult;
      if (result.run?.outcome === "succeeded") {
        seeding ??= seedCoursework(signedIn(subjectOf("teacher")), signedIn(CLASSMATE_SUBJECT));
        await seeding;
        synced = true;
      }
    }
    return response;
  };
  const clientFor = clientsOver(fetch);
  // The district's own work (its configuration, its sync and the seeded coursework) runs in
  // sessions of the people doing it, started here rather than by a sign-in.
  const signedIn = (subject: string) => clientFor(sessions.start(identityOf(subject)));
  const admin = signedIn(subjectOf("admin"));
  await admin.call("admin.applyConfig", { body: { document: config(fake.districtId), acknowledgeApprovals: true } });

  return {
    key: "cedarvalley",
    clientFor,
    clever: fake,
    cleverSso: { districtId: fake.districtId, issuer: IDP },
    sessions,
    roster: {
      provider: "clever",
      synced: () => synced,
      sync: () => admin.call("admin.runRosterSync", { body: {} }),
    },
  };
}

/**
 * The demo teacher posts a short writing assignment in Earth Science 8, the class she shares with
 * the demo student, and a classmate submits it, so she has work to grade and the student has work
 * to do.
 */
async function seedCoursework(teacher: DistrictApiClient, classmate: DistrictApiClient): Promise<void> {
  const offerings = await teacher.call("teacher.listOfferings");
  const earthScience = offerings.find(({ course }) => course.title === "Earth Science 8");
  if (earthScience === undefined) throw new Error("the Clever roster gave the demo teacher no Earth Science 8");
  const params = { offeringId: earthScience.offering.id };
  const rubric = await teacher.call("teacher.signRubric", { params, body: { rubric: EXPLANATION_RUBRIC } });
  const draft = await teacher.call("teacher.createActivity", {
    params,
    body: {
      activity: {
        template: "writing-task",
        subject: "science",
        gradeBand: "8",
        title: "Where does the rain go?",
        overview: "Explain what happens to rain after it falls on the school field.",
        prompt: "Follow a raindrop that lands on the field. Where can it go next, and what decides which way it goes? Write at least a paragraph.",
        genre: "informative",
        minimumCitations: 0,
        aiHelp: "none",
        due: { kind: "after-install", days: 7 },
      },
    },
  });
  await teacher.call("teacher.publishActivity", { params: { definitionId: draft.id } });
  const { assignment } = await teacher.call("teacher.installActivity", {
    params: { definitionId: draft.id },
    body: { offeringId: earthScience.offering.id, assignment: { rubric: { rubricId: rubric.rubricId, version: rubric.version } } },
  });

  const workspace = await classmate.call("student.openCourseWorkspace", { params });
  const { artifact, head } = await classmate.call("student.createArtifact", {
    body: {
      workspaceId: workspace.id,
      type: "document",
      title: "Where the rain goes",
      content: {
        kind: "text",
        mediaType: "text/markdown",
        text: "Some of the rain soaks into the soil and some runs off into the drain by the track. When the ground is already wet or packed hard, more of it runs off. The rest evaporates when the sun comes out.",
      },
    },
  });
  await classmate.call("student.submit", { params: { assignmentId: assignment.id }, body: { revisions: [{ artifactId: artifact.id, revisionId: head.id }] } });
}

const EXPLANATION_RUBRIC = {
  rubricId: "rbr_demo-explanation",
  version: 1,
  title: "Scientific explanation",
  criteria: [{
    id: "explanation",
    title: "Explanation",
    levels: [{ id: "beginning", label: "Beginning", points: 1 }, { id: "developing", label: "Developing", points: 3 }, { id: "clear", label: "Clear", points: 5 }],
    checks: [],
  }],
};
