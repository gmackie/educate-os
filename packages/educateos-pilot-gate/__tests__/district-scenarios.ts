// The district validation suite's scenario bodies (SCHO-205): every integration scenario, run in
// every demo district whose profile it applies to, in process against the provider fakes. Each
// district registers them in its own test file (`districts.<slug>.test.ts`), so the districts run
// in parallel. Which cells run, which are
// blocked by an unmerged issue and which are outside a district's profile is the registry's call
// (`src/districts.ts`); `pnpm --filter @educateos/pilot-gate district-report` turns a run into the
// per-district gate report. Each body acts through the district's own people and data (`castOf`),
// never a district's name.
import { expect } from "vitest";
import { DistrictApiError } from "@educateos/api-client";
import { DEMO_DISTRICTS, type DemoDistrict } from "@educateos/fixtures";
import { FakeIdentityProvider } from "@educateos/harness";
import { integrationHealth, type oneroster } from "@educateos/integrations";
import {
  AgsClient,
  GradePassback,
  InMemoryGradeApprovalStore,
  InMemoryGradeRouteStore,
  InMemoryPassbackLedger,
  LtiAgsGradeSink,
} from "@educateos/lti";
import { InMemoryExportMappingStore, InMemoryStudentRecordSource, readZip, StudentArchiveExporter } from "@educateos/portability";
import { parseAutoSubmitForm } from "@educateos/provider-fakes";
import { restore, snapshot } from "./backup.ts";
import type { ScenarioBody } from "./district-gate.ts";
import {
  beforeFirstSync,
  bootDemo,
  castOf,
  directoryOf,
  districtCsv,
  fakeEnrollmentId,
  fixtureShape,
  formPost,
  importedOffering,
  importedPrincipal,
  ltiWorld,
  restRoster,
  rosterShape,
  signingInFromStore,
  subjectOfPrincipal,
  syncedOffering,
  syncedPrincipal,
  TOOL,
  withEnrollmentEnded,
  withoutEnrollment,
} from "./district-support.ts";
import { entitlementWithRootDown } from "./root.ts";
import {
  approveCatalogSeeds,
  artifactsOf,
  bootDistrictFor,
  callerOf,
  expectDenied,
  expectRefused,
  PilotClock,
  settleAiRequest,
  studentSubmitsEssay,
  teacherInstallsEssay,
  workspacesOf,
  type PilotDistrict,
  type PilotOverrides,
} from "./support.ts";

const issuerOf = (demo: DemoDistrict) => demo.directory.district.trustedIssuers[0]!;
const day = (iso: string, days: number) => new Date(Date.parse(`${iso}T15:00:00Z`) + days * 86_400_000).toISOString();

/** Expects a request to be refused before it reaches any record: no principal for the credential. */
async function expectNoPrincipal(call: Promise<unknown>): Promise<void> {
  const error = await call.then(() => undefined, (caught: unknown) => caught);
  expect(error, "the credential was accepted").toBeInstanceOf(DistrictApiError);
  expect([401, 403]).toContain((error as DistrictApiError).status);
}

/** A district whose directory came from a first OneRoster CSV import by its administrator. */
async function importedFromCsv(demo: DemoDistrict, overrides: PilotOverrides = {}) {
  const district = signingInFromStore(await bootDemo(demo, overrides, beforeFirstSync(demo)));
  const admin = await district.as(castOf(demo).admin.id);
  const result = await admin.call("admin.applyRoster", { body: { files: districtCsv(demo) } });
  if (!result.applied) throw new Error(`the first import did not apply: ${JSON.stringify(result.preview).slice(0, 2000)}`);
  return { district, admin };
}

/** A completed first REST sync of the district's OneRoster server. */
async function syncedFromRest(demo: DemoDistrict) {
  const roster = restRoster(demo);
  const first = await roster.sync(roster.empty, "complete");
  if (first.run.outcome !== "succeeded") throw new Error(`the first sync failed: ${JSON.stringify(first.preview?.issues ?? first.run).slice(0, 2000)}`);
  return { roster, state: first.state, runs: [first.run] };
}

/** Teacher installs an essay in the class and the student submits; the work the drop must keep. */
async function classWork(district: PilotDistrict, teacherId: string, studentId: string, offeringId: string) {
  const { assignment } = await teacherInstallsEssay(district, teacherId, offeringId);
  const work = await studentSubmitsEssay(district, studentId, offeringId, assignment.id);
  expect((await work.student.call("student.listActivities", { params: { offeringId } })).length).toBeGreaterThan(0);
  return { assignment, ...work };
}

/** After a drop: the class is refused on the next request with the same token, and the student's workspace and work remain. */
async function expectDropped(district: PilotDistrict, work: Awaited<ReturnType<typeof classWork>>, offeringId: string, teacherId: string) {
  await expectDenied(work.student.call("student.listActivities", { params: { offeringId } }));
  await expectDenied(work.student.call("student.createArtifact", {
    body: { workspaceId: work.workspace.id, type: "document", title: "After the drop", content: { kind: "text", mediaType: "text/plain", text: "no longer enrolled" } },
  }));
  expect((await work.student.call("student.listWorkspaces")).map((w) => w.id)).toContain(work.workspace.id);
  expect((await work.student.call("student.getArtifact", { params: { artifactId: work.artifact.id } })).revision.id).toBe(work.head.id);
  const teacher = await district.as(teacherId);
  expect((await teacher.call("teacher.listSubmissions", { params: { assignmentId: work.assignment.id } })).map((s) => s.id)).toContain(work.receipt.submissionId);
}

/** A REST sync that must succeed. */
async function synced(roster: ReturnType<typeof restRoster>, state: oneroster.RosterSyncState, mode: "complete" | "delta", approvedRemoval?: string) {
  const result = await roster.sync(state, mode, approvedRemoval);
  if (result.run.outcome !== "succeeded") throw new Error(`the ${mode} sync failed: ${JSON.stringify(result.preview?.issues ?? result.run).slice(0, 2000)}`);
  return result;
}

/** Every scenario's body, by scenario ID. `districts.<slug>.test.ts` registers them for one district each. */
export const SCENARIO_BODIES: Readonly<Record<string, ScenarioBody>> = {
  // ── Identity ────────────────────────────────────────────────────

  "sso-roles": async (demo) => {
    const district = await bootDemo(demo);
    const cast = castOf(demo);
    const people = [cast.student, cast.teacher, cast.admin, ...(cast.guardian === undefined ? [] : [cast.guardian.guardian])];
    for (const person of people) {
      const me = await (await district.as(person.id)).call("me.get");
      expect(me.principalId, `${person.id} signed in as someone else`).toBe(person.id);
    }
    // An expired token, another issuer's token for the same subject, and an unknown subject resolve to no one.
    const subject = subjectOfPrincipal(cast.student);
    await expectNoPrincipal(district.withToken(await district.entry.identity.issueToken(subject, { ttlSeconds: -60 })).call("me.get"));
    await expectNoPrincipal(district.withToken(await new FakeIdentityProvider("https://idp.elsewhere.example").issueToken(subject)).call("me.get"));
    await expectNoPrincipal(district.withToken(await district.entry.identity.issueToken("no-such-person")).call("me.get"));
    // Claims beyond (issuer, subject) change nothing: a student claiming to be an administrator is still the student.
    const claimed = await district.entry.identity.issueToken(subject, { extraClaims: { role: "district-admin", principalId: cast.admin.id } });
    expect((await district.withToken(claimed).call("me.get")).principalId).toBe(cast.student.id);
    await expectDenied(district.withToken(claimed).call("admin.health"));
  },

  "tenant-isolation": async (demo) => {
    const here = await bootDemo(demo);
    const cast = castOf(demo);
    const others = DEMO_DISTRICTS.filter((d) => d.slug !== demo.slug);
    const admin = await here.as(cast.admin.id);
    for (const other of others) {
      // Another district's IdP vouching for this district's administrator's subject is not trusted here.
      const idp = new FakeIdentityProvider(other.directory.district.trustedIssuers[0]!);
      await expectRefused(here.withToken(await idp.issueToken(subjectOfPrincipal(cast.admin))).call("me.get"), 401, "unauthenticated");
      // Another district's records are not reachable by ID, even by this district's administrator.
      await expectDenied(admin.call("admin.offeringRoster", { params: { offeringId: other.directory.offerings[0]!.id } }));
    }
    // A subject another district also uses resolves to each district's own principal. Where the
    // fixtures share none with this district, one is made: the same subject at another district's
    // issuer, given to a new person there.
    const twins = demo.directory.principals.flatMap((p) => others.flatMap((o) => o.directory.principals.filter((q) => subjectOfPrincipal(q) === subjectOfPrincipal(p)).map((q) => ({ here: p, other: o, twin: q }))));
    if (twins.length === 0) {
      const other = others[0]!;
      const twinDirectory = { ...other.directory, principals: [...other.directory.principals, { ...other.directory.principals.find((p) => p.kind === "student")!, id: `prn_${other.slug}-twin` as never, externalIdentities: [{ districtId: other.directory.district.id, issuer: other.directory.district.trustedIssuers[0]!, subject: subjectOfPrincipal(cast.student) }] }] };
      twins.push({ here: cast.student, other: { ...other, directory: twinDirectory }, twin: twinDirectory.principals.at(-1)! });
    }
    for (const { here: principal, other, twin } of twins) {
      expect((await (await here.as(principal.id)).call("me.get")).principalId).toBe(principal.id);
      const there = await bootDemo(other, {}, other.directory);
      expect((await (await there.as(twin.id)).call("me.get")).principalId, "the shared subject resolved to the other district's principal there").toBe(twin.id);
      await expectRefused(there.withToken(await here.entry.identity.issueToken(subjectOfPrincipal(principal))).call("me.get"), 401, "unauthenticated");
    }
  },

  // ── Rostering ───────────────────────────────────────────────────

  "roster-first-sync": async (demo) => {
    const issuer = issuerOf(demo);
    const expected = rosterShape(demo.directory, issuer);
    const cast = castOf(demo);
    switch (demo.profile.roster) {
      case "oneroster-csv": {
        const { district } = await importedFromCsv(demo);
        expect(rosterShape(await directoryOf(district), issuer)).toStrictEqual(expected);
        // The people the import made sign in as themselves.
        const student = await importedPrincipal(district, cast.student.id);
        expect((await (await district.as(cast.admin.id)).call("me.get")).principalId).toBe(cast.admin.id);
        expect((await district.withToken(await district.entry.identity.issueToken(subjectOfPrincipal(cast.student))).call("me.get")).principalId).toBe(student);
        return;
      }
      case "oneroster-rest": {
        const { state, runs } = await syncedFromRest(demo);
        expect(runs[0]).toMatchObject({ mode: "complete", outcome: "succeeded" });
        expect(fixtureShape(state.roster.snapshot, state.roster.sources)).toStrictEqual(fixtureShape(demo.directory));
        // Every synced person can be signed in to: one identity at the district's trusted issuer.
        expect(state.roster.snapshot.principals.every((p) => p.externalIdentities.some((i) => i.issuer === issuer))).toBe(true);
        return;
      }
      case "local": {
        // A district with no roster source: its administrator keeps the directory by hand.
        const district = await bootDemo(demo);
        const admin = await district.as(cast.admin.id);
        const created = await admin.call("admin.createPrincipal", {
          body: { kind: "student", displayName: "Nova Newcomer (synthetic)", email: `nova.newcomer@${demo.slug}.example`, identity: { issuer, subject: "nova-newcomer" } },
        });
        await admin.call("admin.enroll", { params: { offeringId: cast.offeringId }, body: { principalId: created.id, role: "student" } });
        const teacher = await district.as(cast.teacher.id);
        expect((await teacher.call("teacher.roster", { params: { offeringId: cast.offeringId } })).map((r) => r.enrollment.principalId)).toContain(created.id);
        const newcomer = district.withToken(await district.entry.identity.issueToken("nova-newcomer"));
        expect((await newcomer.call("me.get")).principalId).toBe(created.id);
        expect((await newcomer.call("student.listOfferings")).map((o) => o.offering.id)).toContain(cast.offeringId);
        return;
      }
      default:
        throw new Error(`no first-sync body for roster ${demo.profile.roster}`);
    }
  },

  "roster-delta": async (demo) => {
    const issuer = issuerOf(demo);
    const cast = castOf(demo);
    switch (demo.profile.roster) {
      case "oneroster-csv": {
        // The SIS corrects one student's name; the next import changes only that.
        const { district, admin } = await importedFromCsv(demo);
        const before = await directoryOf(district);
        const renamed = districtCsv(demo, (seed) => ({ ...seed, users: seed.users.map((u) => (u.sourcedId === cast.student.id ? { ...u, givenName: "Renamed" } : u)) }));
        expect((await admin.call("admin.applyRoster", { body: { files: renamed } })).applied).toBe(true);
        const after = await directoryOf(district);
        const id = await importedPrincipal(district, cast.student.id);
        const changed = after.principals.filter((p) => JSON.stringify(p) !== JSON.stringify(before.principals.find((q) => q.id === p.id)));
        expect(changed.map((p) => p.id)).toStrictEqual([id]);
        expect(changed[0]!.displayName).toMatch(/^Renamed /);
        expect(rosterShape(after, issuer)).toStrictEqual(rosterShape(before, issuer));
        expect(after.enrollments).toStrictEqual(before.enrollments);
        return;
      }
      case "oneroster-rest": {
        // One enrollment ends at the SIS; a delta deactivates exactly it.
        const { roster, state } = await syncedFromRest(demo);
        roster.fake.remove("enrollments", fakeEnrollmentId(cast.offeringId, cast.peer.id));
        const delta = await synced(roster, state, "delta");
        expect(delta.run.mode).toBe("delta");
        const { counts } = delta.run;
        expect(counts.enrollments).toStrictEqual({ added: 0, updated: 0, deactivated: 1 });
        for (const kind of ["schools", "terms", "courses", "offerings", "principals"] as const) expect(counts[kind], kind).toStrictEqual({ added: 0, updated: 0, deactivated: 0 });
        const peer = syncedPrincipal(delta.state, cast.peer.id);
        const offering = syncedOffering(delta.state, cast.offeringId);
        expect(delta.state.roster.snapshot.enrollments.find((e) => e.principalId === peer.id && e.offeringId === offering)?.status).toBe("inactive");
        expect(peer.status).toBe("active");
        // The same delta again changes nothing.
        expect((await synced(roster, delta.state, "delta")).run.counts.enrollments).toStrictEqual({ added: 0, updated: 0, deactivated: 0 });
        return;
      }
      default:
        throw new Error(`no delta body for roster ${demo.profile.roster}`);
    }
  },

  drop: async (demo) => {
    const cast = castOf(demo);
    switch (demo.profile.roster) {
      case "oneroster-csv": {
        const { district, admin } = await importedFromCsv(demo);
        const offeringId = await importedOffering(district, cast.offeringId);
        const teacherId = await importedPrincipal(district, cast.teacher.id);
        const studentId = await importedPrincipal(district, cast.student.id);
        const work = await classWork(district, teacherId, studentId, offeringId);
        const dropped = await admin.call("admin.applyRoster", { body: { files: districtCsv(demo, withoutEnrollment(cast.student.id, cast.offeringId)) } });
        expect(dropped.applied).toBe(true);
        expect(dropped.grantsRevoked).toBeGreaterThan(0);
        await expectDropped(district, work, offeringId, teacherId);
        // Re-enrolled at the SIS, the same workspace comes back.
        await admin.call("admin.applyRoster", { body: { files: districtCsv(demo) } });
        expect((await work.student.call("student.openCourseWorkspace", { params: { offeringId } })).id).toBe(work.workspace.id);
        return;
      }
      case "local": {
        const district = await bootDemo(demo);
        const work = await classWork(district, cast.teacher.id, cast.student.id, cast.offeringId);
        const enrollment = demo.directory.enrollments.find((e) => e.offeringId === cast.offeringId && e.principalId === cast.student.id)!;
        const admin = await district.as(cast.admin.id);
        expect((await admin.call("admin.unenroll", { params: { enrollmentId: enrollment.id } })).enrollment.status).toBe("inactive");
        await expectDropped(district, work, cast.offeringId, cast.teacher.id);
        return;
      }
      default:
        throw new Error(`no drop body for roster ${demo.profile.roster}`);
    }
  },

  "roster-outage": async (demo) => {
    const { roster, state, runs } = await syncedFromRest(demo);
    const sla = { maxStalenessMinutes: 24 * 60 };
    roster.fake.inject({ kind: "outage", status: 503 });
    const down = await roster.sync(state, "delta");
    expect(down.run).toMatchObject({ outcome: "failed", errorCode: "source-unavailable" });
    expect(down.state, "a failed sync leaves the directory as it was").toBe(state);
    runs.push(down.run);
    expect(integrationHealth(runs, sla, new Date(roster.clock.ms))).toMatchObject({ status: "degraded", consecutiveFailures: 1, lastErrorCode: "source-unavailable" });
    roster.fake.clearFaults();
    const up = await synced(roster, state, "delta");
    runs.push(up.run);
    expect(integrationHealth(runs, sla, new Date(roster.clock.ms))).toMatchObject({ status: "healthy", consecutiveFailures: 0 });
    expect(fixtureShape(up.state.roster.snapshot, up.state.roster.sources)).toStrictEqual(fixtureShape(state.roster.snapshot, state.roster.sources));
  },

  "large-removal-hold": async (demo) => {
    const { roster, state } = await syncedFromRest(demo);
    const before = fixtureShape(state.roster.snapshot, state.roster.sources);
    // A botched SIS export: most of the students vanish at once.
    roster.fake.inject({ kind: "large-removal", fraction: 0.6 });
    const held = await roster.sync(state, "complete");
    expect(held.run).toMatchObject({ outcome: "failed", errorCode: "removal-held" });
    expect(held.state, "a held sync leaves the directory as it was").toBe(state);
    expect(held.held!.principals.deactivated).toBeGreaterThanOrEqual(Math.ceil(0.6 * demo.directory.principals.filter((p) => p.kind === "student").length));
    expect(fixtureShape(held.state.roster.snapshot, held.state.roster.sources)).toStrictEqual(before);
    // The administrator approves exactly that removal, and only then does it apply: deactivated, not deleted.
    const approved = await synced(roster, state, "complete", held.held!.fingerprint);
    const after = approved.state.roster.snapshot;
    expect(after.principals).toHaveLength(state.roster.snapshot.principals.length);
    expect(after.principals.filter((p) => p.status === "inactive").length).toBe(held.held!.principals.deactivated);
  },

  // ── LMS ─────────────────────────────────────────────────────────

  "lti-launch": async (demo) => {
    const world = await ltiWorld(demo);
    const cast = castOf(demo);
    for (const person of [cast.student, cast.teacher]) {
      const launch = await world.accepted({ sectionId: cast.offeringId, personId: person.id });
      expect(launch).toMatchObject({ principal: { principalId: person.id }, offeringId: cast.offeringId, messageType: "LtiResourceLinkRequest" });
      expect(launch.services?.registration).toStrictEqual({ issuer: world.fake.issuer, clientId: world.tool.clientId });
    }
  },

  "lti-deep-link": async (demo) => {
    const world = await ltiWorld(demo);
    const cast = castOf(demo);
    const request = await world.launch({ sectionId: cast.offeringId, personId: cast.teacher.id, messageType: "LtiDeepLinkingRequest" });
    expect(request.status).toBe(200);
    const { session } = (await request.json()) as { session: string };
    const chosen = (await world.handler(formPost(`${TOOL}/lti/deep-link`, [["session", session], ["activity", "act_validation-lab"]])))!;
    const form = parseAutoSubmitForm(await chosen.text())!;
    const returned = await world.fake.fetch(form.action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form.fields).toString(),
    });
    expect(returned.status, "the platform refused the Deep Linking response").toBe(200);
    const link = world.fake.deepLinkResults[0]!.links[0]!;
    expect(link).toMatchObject({ title: "Activity act_validation-lab", url: `${TOOL}/lti/launch` });
    const launched = await world.accepted({ sectionId: cast.offeringId, personId: cast.student.id, resourceLinkId: link.id });
    expect(launched.activity).toBe("act_validation-lab");
    expect(launched.principal.principalId).toBe(cast.student.id);
  },

  "lti-ags": async (demo) => {
    const { world, passback, request, approve } = await agsSetup(demo);
    await expect(passback.publish(request), "an unapproved grade was sent").rejects.toMatchObject({ code: "policy-violation" });
    expect(world.fake.scores).toStrictEqual([]);
    approve();
    expect(await passback.publish(request)).toStrictEqual({ status: "posted", route: "lti-ags" });
    expect(await passback.publish(request)).toStrictEqual({ status: "already-posted", route: "lti-ags" });
    expect(world.fake.scores).toHaveLength(1);
    expect(world.fake.scores[0]!.score).toMatchObject({ userId: world.fake.userOf(request.studentId).sub, scoreGiven: 8, scoreMaximum: 10 });
  },

  "lms-outage": async (demo) => {
    const { world, passback, request, approve } = await agsSetup(demo);
    approve();
    world.fake.inject({ kind: "outage", status: 503 });
    await expect(passback.publish(request)).rejects.toMatchObject({ code: "unavailable" });
    expect(world.fake.scores).toStrictEqual([]);
    world.fake.clearFaults();
    expect(await passback.publish(request), "the failed delivery was recorded as posted").toStrictEqual({ status: "posted", route: "lti-ags" });
    expect(world.fake.scores).toHaveLength(1);
  },

  // ── Operations ──────────────────────────────────────────────────

  "term-rollover": async (demo) => {
    const cast = castOf(demo);
    const term = demo.directory.terms.find((t) => t.id === cast.termId)!;
    const clock = new PilotClock(day(term.startsOn, 21));
    const csv = demo.profile.roster === "oneroster-csv";
    let district: PilotDistrict;
    let ids = { termId: term.id, offeringId: cast.offeringId, teacherId: cast.teacher.id, studentId: cast.student.id };
    if (csv) {
      ({ district } = await importedFromCsv(demo, { now: clock.now }));
      const offeringId = await importedOffering(district, cast.offeringId);
      const termId = (await directoryOf(district)).offerings.find((o) => o.id === offeringId)!.termId;
      ids = { termId, offeringId, teacherId: await importedPrincipal(district, cast.teacher.id), studentId: await importedPrincipal(district, cast.student.id) };
    } else {
      district = await bootDemo(demo, { now: clock.now });
    }
    const { assignment, student, artifact, head, workspace, receipt } = await classWork(district, ids.teacherId, ids.studentId, ids.offeringId);
    expect((await settleAiRequest(district, ids.studentId, ids.offeringId, 2)).effect).toBe("allow");

    // The term ends where its source of record is: the next roster import, or the administrator.
    clock.set(day(term.endsOn, 10));
    const admin = await district.as(cast.admin.id);
    if (csv) await admin.call("admin.applyRoster", { body: { files: districtCsv(demo) } });
    else for (const to of ["grading", "completed"] as const) await admin.call("admin.transitionTerm", { params: { termId: ids.termId }, body: { to } });
    expect((await directoryOf(district)).terms.find((t) => t.id === ids.termId)?.state).toBe("completed");
    // The student's course workspace held two grants, its tools and its AI funding; each of the term's classes loses its course funding.
    const classes = (await directoryOf(district)).offerings.filter((o) => o.termId === ids.termId).length;
    expect(await admin.call("admin.closeTerm", { params: { termId: ids.termId } })).toStrictEqual({ retained: 1, grantsRevoked: 2, fundingCancellations: classes });

    await expectDenied(student.call("student.saveRevision", { params: { artifactId: artifact.id }, body: { content: { kind: "text", mediaType: "text/plain", text: "after the term" } } }));
    expect(await settleAiRequest(district, ids.studentId, ids.offeringId, 1)).toMatchObject({ effect: "deny", reason: "term-closed" });
    expect((await student.call("student.getArtifact", { params: { artifactId: artifact.id } })).revision.id).toBe(head.id);
    await student.call("student.openPersonalWorkspace");
    expect(await student.call("student.keepArtifact", { params: { workspaceId: workspace.id, artifactId: artifact.id } })).toMatchObject({ artifactId: artifact.id });
    expect((await student.call("student.listSubmissions", { params: { assignmentId: assignment.id } })).map((s) => s.id)).toStrictEqual([receipt.submissionId]);
  },

  "export-restore": async (demo) => {
    const cast = castOf(demo);
    let district: PilotDistrict | undefined = await bootDemo(demo);
    const { teacher, assignment } = await teacherInstallsEssay(district, cast.teacher.id, cast.offeringId);
    const own = await district.as(cast.student.id);
    const personal = await own.call("student.openPersonalWorkspace");
    await own.call("student.createArtifact", { body: { workspaceId: personal.id, type: "document", title: "Journal", content: { kind: "text", mediaType: "text/plain", text: "OWN-JOURNAL-ENTRY" } } });
    const mine = await studentSubmitsEssay(district, cast.student.id, cast.offeringId, assignment.id, "OWN-ESSAY school should start later because teenagers need sleep.");
    const peer = await studentSubmitsEssay(district, cast.peer.id, cast.offeringId, assignment.id, "PEER-WORK the school day is fine as it is, and here is why.");
    await teacher.call("teacher.addComment", { params: { submissionId: peer.receipt.submissionId }, body: { body: "TEACHER-ONLY-NOTE for the peer." } });

    // The student's archive: their own work, and nothing of anyone else's.
    const exporter = new StudentArchiveExporter({
      artifacts: artifactsOf(district),
      workspaces: workspacesOf(district),
      directory: district.stores.directory,
      policy: district.app.engine,
      records: new InMemoryStudentRecordSource(),
      mappings: new InMemoryExportMappingStore(),
      now: () => new Date(),
    });
    const exported = await exporter.exportStudentArchive(callerOf(district, cast.student.id));
    const text = (await readZip(exported.bytes)).map((entry) => new TextDecoder().decode(entry.bytes)).join("\n");
    expect(text).toContain("OWN-JOURNAL-ENTRY");
    for (const forbidden of ["PEER-WORK", "TEACHER-ONLY-NOTE", cast.peer.displayName, cast.peer.id]) expect(text).not.toContain(forbidden);

    // A backup restored into fresh stores serves the same district.
    const views = async (d: PilotDistrict) => {
      const [t, s, a] = await Promise.all([d.as(cast.teacher.id), d.as(cast.student.id), d.as(cast.admin.id)]);
      return {
        roster: await t.call("teacher.roster", { params: { offeringId: cast.offeringId } }),
        submissions: await t.call("teacher.listSubmissions", { params: { assignmentId: assignment.id } }),
        workspaces: await s.call("student.listWorkspaces"),
        essay: await s.call("student.getArtifact", { params: { artifactId: mine.artifact.id } }),
        usage: await a.call("admin.aiUsage"),
      };
    };
    const before = await views(district);
    const backup = await snapshot(district.stores);
    const entry = district.entry;
    district = undefined;
    const restored = await bootDistrictFor(entry, { stores: await restore(structuredClone(backup)) });
    await approveCatalogSeeds(restored.app, restored.directory);
    expect(await views(restored)).toStrictEqual(before);
    const again = await studentSubmitsEssay(restored, cast.student.id, cast.offeringId, assignment.id, "A resubmission after the restore, long enough to count.");
    expect(again.receipt.attempt).toBe(2);
  },

  "root-offline": async (demo) => {
    const cast = castOf(demo);
    const district = await bootDemo(demo);
    const { cache, rootDown, rootCalls } = await entitlementWithRootDown(district.app.districtId);
    const refreshed = await cache.refresh(rootDown);
    expect(refreshed.outcome).toBe("root-unreachable");
    expect(refreshed.evaluation).toMatchObject({ state: "valid", classroom: "unaffected" });
    const { teacher, assignment } = await teacherInstallsEssay(district, cast.teacher.id, cast.offeringId);
    const { receipt } = await studentSubmitsEssay(district, cast.student.id, cast.offeringId, assignment.id);
    await teacher.call("teacher.runCi", { params: { submissionId: receipt.submissionId } });
    expect((await teacher.call("teacher.recordGrade", { params: { submissionId: receipt.submissionId }, body: { score: { points: 3, maxPoints: 4 } } })).status).toBe("official");
    expect((await settleAiRequest(district, cast.student.id, cast.offeringId, 2)).effect).toBe("allow");
    expect((await cache.refresh(rootDown)).evaluation).toMatchObject({ state: "valid", classroom: "unaffected" });
    expect(rootCalls()).toBe(2);
  },

  // ── RFC 0002 §10 matrix rows ────────────────────────────────────

  "rfc-wrong-course": async (demo) => {
    const cast = castOf(demo);
    if (cast.otherTeacher === undefined) throw new Error(`${demo.slug} has no second teacher to ask`);
    const district = await bootDemo(demo);
    const { assignment, receipt } = await classWork(district, cast.teacher.id, cast.student.id, cast.offeringId);
    const other = await district.as(cast.otherTeacher.id);
    await expectDenied(other.call("teacher.roster", { params: { offeringId: cast.offeringId } }));
    await expectDenied(other.call("teacher.listSubmissions", { params: { assignmentId: assignment.id } }));
    await expectDenied(other.call("teacher.recordGrade", { params: { submissionId: receipt.submissionId }, body: { score: { points: 4, maxPoints: 4 } } }));
  },

  "rfc-expired-role": async (demo) => {
    const cast = castOf(demo);
    // The district's own inactive student enrollment if it has one; otherwise the peer's, ended as
    // the source of record would leave it.
    const ended = demo.directory.enrollments.find((e) => e.role === "student" && e.status === "inactive")
      ?? { ...demo.directory.enrollments.find((e) => e.offeringId === cast.offeringId && e.principalId === cast.peer.id)!, status: "inactive" as const };
    const district = await bootDemo(demo, {}, withEnrollmentEnded(demo.directory, ended.principalId, ended.offeringId));
    const student = await district.as(ended.principalId);
    await expectDenied(student.call("student.listActivities", { params: { offeringId: ended.offeringId } }));
    await expectDenied(student.call("student.openCourseWorkspace", { params: { offeringId: ended.offeringId } }));
    // The teacher's roster no longer lists them as an active student.
    const teacherId = demo.directory.enrollments.find((e) => e.offeringId === ended.offeringId && e.role === "teacher" && e.status === "active")!.principalId;
    const roster = await (await district.as(teacherId)).call("teacher.roster", { params: { offeringId: ended.offeringId } });
    expect(roster.filter((r) => r.enrollment.principalId === ended.principalId && r.enrollment.status === "active")).toStrictEqual([]);
    // A completed term's class grants no new work, where the district has one.
    const done = demo.directory.offerings.find((o) => demo.directory.terms.find((t) => t.id === o.termId)?.state === "completed"
      && demo.directory.enrollments.some((e) => e.offeringId === o.id && e.role === "student" && e.status === "active"));
    if (done !== undefined) {
      const pastStudent = demo.directory.enrollments.find((e) => e.offeringId === done.id && e.role === "student" && e.status === "active")!.principalId;
      await expectDenied((await district.as(pastStudent)).call("student.openCourseWorkspace", { params: { offeringId: done.id } }));
    }
  },

  "rfc-guardian-other-family": async (demo) => {
    const district = await bootDemo(demo);
    const students = demo.directory.principals.filter((p) => p.kind === "student");
    const guardianIds = [...new Set(demo.guardians.map((g) => g.guardianPrincipalId))];
    expect(guardianIds.length, "the district has no guardian to ask").toBeGreaterThan(0);
    for (const guardianId of guardianIds) {
      // Only a confirmed relationship opens a child; a pending one opens nothing yet.
      const own = demo.guardians.filter((g) => g.guardianPrincipalId === guardianId && g.status === "active").map((g) => g.studentPrincipalId);
      const guardian = await district.as(guardianId);
      expect((await guardian.call("guardian.listChildren")).map((c) => c.studentPrincipalId).toSorted()).toStrictEqual(own.toSorted());
      const others = students.filter((s) => !own.includes(s.id));
      expect(others.length, "every student is this guardian's child").toBeGreaterThan(0);
      // Another family's child, and a child whose relationship is still pending, are refused.
      for (const stranger of others) await expectDenied(guardian.call("guardian.childOfferings", { params: { studentId: stranger.id } }));
      for (const child of own) expect(await guardian.call("guardian.childOfferings", { params: { studentId: child } })).toBeInstanceOf(Array);
    }
  },

  "rfc-duplicate-write": async (demo) => {
    const cast = castOf(demo);
    const district = await bootDemo(demo);
    const { teacher, assignment } = await teacherInstallsEssay(district, cast.teacher.id, cast.offeringId);
    const { student, artifact, head, receipt } = await studentSubmitsEssay(district, cast.student.id, cast.offeringId, assignment.id);
    for (let i = 0; i < 2; i++) {
      const repeat = await student.call("student.submit", { params: { assignmentId: assignment.id }, body: { revisions: [{ artifactId: artifact.id, revisionId: head.id }] } });
      expect(repeat).toMatchObject({ submissionId: receipt.submissionId, attempt: 1 });
    }
    expect((await teacher.call("teacher.listSubmissions", { params: { assignmentId: assignment.id } })).filter((s) => s.studentPrincipalId === cast.student.id)).toHaveLength(1);
  },
};

/** An LTI world with an AGS line item for the class, and a grade passback routed to the platform. */
async function agsSetup(demo: DemoDistrict) {
  const world = await ltiWorld(demo);
  const cast = castOf(demo);
  const launch = await world.accepted({ sectionId: cast.offeringId, personId: cast.student.id });
  const services = launch.services!;
  const ags = new AgsClient({ services: world.services, registrations: world.registrations });
  const column = await ags.createLineItem(services, { label: "Validation essay", scoreMaximum: 10, resourceId: "act_validation-essay" });
  const approvals = new InMemoryGradeApprovalStore();
  const passback = new GradePassback({
    districtId: world.districtId,
    directory: async () => world.directory,
    routes: new InMemoryGradeRouteStore([{ offeringId: cast.offeringId, authority: `lms:${world.fake.flavour.name}`, via: "lti-ags", services }]),
    approvals,
    ledger: new InMemoryPassbackLedger(),
    sinks: [new LtiAgsGradeSink({ services: world.services, registrations: world.registrations })],
    now: world.now,
  });
  const request = { offeringId: cast.offeringId, studentId: cast.student.id, column: column.id, gradeVersion: 1, scoreGiven: 8, scoreMaximum: 10 };
  const approve = () => approvals.record({ ...request, approverId: cast.teacher.id, approvedAt: new Date(world.now() - 5 * 60_000).toISOString() });
  return { world, passback, request, approve };
}
