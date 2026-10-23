// SCHO-189: announcements, weekly notes, calendar and its iCalendar feed, notifications and their
// email, and the weekly family digest, over the district's HTTP surface, each with who it refuses.
import { describe, expect, it } from "vitest";
import { GuardianRelationship, type DistrictDirectorySnapshot, type PrincipalId } from "@schoolos/contracts";
import { InMemoryMailSender, calendarFeedPath, type DistrictAppOptions } from "../src/index.ts";
import { bootDistrict, expectError, NF, NORTHFIELD, RB, RIVERBEND, studentSubmitsEssay, teacherSetsUpEssay, type TestDistrict } from "./support.ts";

/** A clock the tests move: Sunday 25 October 2026, 14:00 UTC, unless a test changes it. */
function testClock(start = "2026-10-25T14:00:00Z") {
  const clock = { at: new Date(start), now: () => clock.at, advance: (ms: number) => (clock.at = new Date(clock.at.getTime() + ms)) };
  return clock;
}
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Amara and Chidi's guardian (siblings), and Elena's. */
const GUARDIAN = { okafor: "prn_nf-guardian-okafor", sato: "prn_nf-guardian-sato" } as const;

/** Northfield with two guardians, one of them with an email address. */
function withGuardians(): DistrictDirectorySnapshot {
  const directory = structuredClone(NORTHFIELD);
  const issuer = directory.district.trustedIssuers[0]!;
  for (const [id, name, email] of [[GUARDIAN.okafor, "Grace Okafor", "grace.okafor@family.example"], [GUARDIAN.sato, "Ken Sato", undefined]] as const) {
    directory.principals.push({
      id: id as PrincipalId,
      districtId: directory.district.id,
      kind: "guardian",
      status: "active",
      displayName: name,
      ...(email === undefined ? {} : { email }),
      externalIdentities: [{ districtId: directory.district.id, issuer, subject: `guardian-${id}` }],
    } as DistrictDirectorySnapshot["principals"][number]);
  }
  return directory;
}

/** A confirmed relationship in force, with `overrides`. */
function relationship(id: string, guardian: string, student: string, overrides: Partial<GuardianRelationship> = {}): GuardianRelationship {
  return GuardianRelationship.parse({
    id,
    districtId: "dst_northfield",
    guardianPrincipalId: guardian,
    studentPrincipalId: student,
    status: "active",
    readableKinds: ["offering", "activity", "feedback", "official-grade", "announcement"],
    consent: "not-required",
    validFrom: "2026-08-01T00:00:00Z",
    created: { by: NF.admin, at: "2026-08-01T00:00:00Z" },
    confirmed: { by: NF.admin, at: "2026-08-02T00:00:00Z" },
    ...overrides,
  });
}

async function boot(options: Partial<Pick<DistrictAppOptions, "mail" | "appUrl">> = {}, start?: string) {
  const clock = testClock(start);
  const district = await bootDistrict(withGuardians(), { now: clock.now, ...options });
  return { district, clock };
}

const post = (district: TestDistrict, title: string, extra: { publishAt?: string } = {}, offeringId: string = NF.eng9) =>
  district.ok(district.tokenFor(NF.rivera), "teacher.createAnnouncement", { params: { offeringId }, body: { title, body: `${title}, in full.`, ...extra } });

describe("announcements", () => {
  it("are posted by the class's teachers and read by its students, in the class and across classes", async () => {
    const { district } = await boot();
    const posted = await post(district, "Library visit on Friday");
    expect(posted).toMatchObject({ published: true, courseLabel: "English 9 (Period 3)", announcement: { offeringId: NF.eng9, created: { by: NF.rivera } } });
    // The co-teacher posts too.
    await district.ok(district.tokenFor(NF.chen), "teacher.createAnnouncement", { params: { offeringId: NF.eng9 }, body: { title: "Bring a novel", body: "Any novel." } });

    const amara = district.tokenFor(NF.amara);
    const inClass = await district.ok(amara, "student.courseAnnouncements", { params: { offeringId: NF.eng9 } });
    expect(inClass.map((a) => a.announcement.title).toSorted()).toStrictEqual(["Bring a novel", "Library visit on Friday"]);
    const everywhere = await district.ok(amara, "student.announcements");
    expect(everywhere).toHaveLength(2);
    // Felix is in none of English 9, so his feed is empty and the class's is closed to him.
    expect(await district.ok(district.tokenFor("prn_nf-student-felix"), "student.announcements")).toStrictEqual([]);
  });

  it("stay hidden from students until their scheduled time, and can be rescheduled only until then", async () => {
    const { district, clock } = await boot();
    const scheduled = await post(district, "Quiz moved", { publishAt: new Date(clock.at.getTime() + 2 * DAY).toISOString() });
    expect(scheduled.published).toBe(false);
    const amara = district.tokenFor(NF.amara);
    expect(await district.ok(amara, "student.courseAnnouncements", { params: { offeringId: NF.eng9 } })).toStrictEqual([]);
    expect(await district.ok(district.tokenFor(NF.rivera), "teacher.listAnnouncements", { params: { offeringId: NF.eng9 } })).toHaveLength(1);

    const rescheduled = await district.ok(district.tokenFor(NF.rivera), "teacher.updateAnnouncement", {
      params: { announcementId: scheduled.announcement.id },
      body: { publishAt: new Date(clock.at.getTime() + DAY).toISOString(), title: "Quiz moved to Thursday" },
    });
    expect(rescheduled.announcement.title).toBe("Quiz moved to Thursday");
    clock.advance(DAY + HOUR);
    expect((await district.ok(amara, "student.courseAnnouncements", { params: { offeringId: NF.eng9 } })).map((a) => a.announcement.title)).toStrictEqual(["Quiz moved to Thursday"]);
    expectError(await district.call(district.tokenFor(NF.rivera), "teacher.updateAnnouncement", {
      params: { announcementId: scheduled.announcement.id },
      body: { publishAt: new Date(clock.at.getTime() + DAY).toISOString() },
    }), 409, "conflict");
  });

  it("are retracted by a teacher, and kept from everyone afterwards", async () => {
    const { district } = await boot();
    const posted = await post(district, "Wrong room");
    expect(await district.ok(district.tokenFor(NF.rivera), "teacher.deleteAnnouncement", { params: { announcementId: posted.announcement.id } })).toStrictEqual({ deleted: true });
    expect(await district.ok(district.tokenFor(NF.amara), "student.courseAnnouncements", { params: { offeringId: NF.eng9 } })).toStrictEqual([]);
    expect(await district.ok(district.tokenFor(NF.rivera), "teacher.listAnnouncements", { params: { offeringId: NF.eng9 } })).toStrictEqual([]);
    // Retracting again changes nothing; the record is kept.
    await district.ok(district.tokenFor(NF.rivera), "teacher.deleteAnnouncement", { params: { announcementId: posted.announcement.id } });
    expect(await district.app.stores.communication.announcements.get(posted.announcement.id)).toMatchObject({ deleted: { by: NF.rivera } });
  });

  it("refuse students outside the class, other teachers, administrators' writes, completed terms and other districts", async () => {
    const { district } = await boot();
    const posted = await post(district, "Field trip forms");
    const body = { title: "Not mine", body: "Should not post." };
    const read = { params: { offeringId: NF.eng9 } };
    // Dmitri was dropped from English 9; Felix was never in it.
    expectError(await district.call(district.tokenFor(NF.dmitri), "student.courseAnnouncements", read), 404, "not-found");
    expectError(await district.call(district.tokenFor("prn_nf-student-felix"), "student.courseAnnouncements", read), 404, "not-found");
    // Morgan teaches Biology, not English 9.
    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.createAnnouncement", { ...read, body }), 404, "not-found");
    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.updateAnnouncement", { params: { announcementId: posted.announcement.id }, body: { title: "Mine now" } }), 404, "not-found");
    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.deleteAnnouncement", { params: { announcementId: posted.announcement.id } }), 404, "not-found");
    // An administrator reads the class's announcements but does not post them.
    expect(await district.ok(district.tokenFor(NF.admin), "teacher.listAnnouncements", read)).toHaveLength(1);
    expectError(await district.call(district.tokenFor(NF.admin), "teacher.createAnnouncement", { ...read, body }), 403, "forbidden");
    // Students cannot reach the teacher surface at all.
    expectError(await district.call(district.tokenFor(NF.amara), "teacher.createAnnouncement", { ...read, body }), 403, "forbidden");
    // Spring Biology's term is completed: read-only.
    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.createAnnouncement", { params: { offeringId: NF.bioSpring }, body }), 403, "forbidden");
    // Another district knows neither the offering nor the announcement.
    const riverbend = await bootDistrict(RIVERBEND);
    expectError(await riverbend.call(riverbend.tokenFor(RB.teacher), "teacher.createAnnouncement", { ...read, body }), 404, "not-found");
    expectError(await riverbend.call(riverbend.tokenFor(RB.teacher), "teacher.deleteAnnouncement", { params: { announcementId: posted.announcement.id } }), 404, "not-found");
    expectError(await riverbend.call(riverbend.tokenFor(RB.student), "student.courseAnnouncements", read), 404, "not-found");
  });
});

describe("weekly notes", () => {
  it("are set and cleared by the class's instructors for the coming digest week", async () => {
    const { district } = await boot();
    const set = await district.ok(district.tokenFor(NF.chen), "teacher.setWeeklyNote", { params: { offeringId: NF.eng9 }, body: { text: "We start Of Mice and Men." } });
    expect(set).toMatchObject({ week: "2026-W44", note: { text: "We start Of Mice and Men.", updated: { by: NF.chen } } });
    expect(await district.ok(district.tokenFor(NF.rivera), "teacher.weeklyNote", { params: { offeringId: NF.eng9 } })).toStrictEqual(set);
    expect(await district.ok(district.tokenFor(NF.rivera), "teacher.setWeeklyNote", { params: { offeringId: NF.eng9 }, body: { week: "2026-W44", text: "  " } }))
      .toStrictEqual({ week: "2026-W44", note: null });
    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.setWeeklyNote", { params: { offeringId: NF.eng9 }, body: { text: "x" } }), 404, "not-found");
    expectError(await district.call(district.tokenFor(NF.admin), "teacher.setWeeklyNote", { params: { offeringId: NF.eng9 }, body: { text: "x" } }), 403, "forbidden");
    expectError(await district.call(district.tokenFor(NF.rivera), "teacher.weeklyNote", { params: { offeringId: NF.eng9 }, query: { week: "2026-W99" } }), 400, "validation-failed");
  });
});

describe("calendar", () => {
  it("shows a student their due dates, published announcements and term dates; staff also see scheduled announcements", async () => {
    const { district, clock } = await boot(undefined, "2026-08-25T12:00:00Z");
    const { assignment } = await teacherSetsUpEssay(district);
    await post(district, "Welcome");
    await post(district, "First quiz", { publishAt: new Date(clock.at.getTime() + 3 * DAY).toISOString() });

    const student = await district.ok(district.tokenFor(NF.amara), "me.calendar");
    expect(student.events.map((e) => [e.kind, e.title])).toStrictEqual([
      ["announcement", "Announcement: Welcome — English 9 (Period 3)"],
      ["term-start", "Fall 2026 begins"],
      ["assignment-due", `Due: ${assignment.title} — English 9 (Period 3)`],
    ]);
    expect(student.events.find((e) => e.kind === "assignment-due")).toMatchObject({ uid: `due-${assignment.id}@dst_northfield.schoolos`, start: assignment.dueAt, allDay: false });
    const teacher = await district.ok(district.tokenFor(NF.rivera), "me.calendar");
    expect(teacher.events.map((e) => e.title)).toContain("Scheduled announcement: First quiz — English 9 (Period 3)");

    // A wider range reaches the term's end; nothing outside a student's classes ever appears.
    const term = await district.ok(district.tokenFor(NF.amara), "me.calendar", { query: { from: "2026-08-01T00:00:00Z", to: "2027-02-01T00:00:00Z" } });
    expect(term.events.filter((e) => e.allDay).map((e) => [e.title, e.start])).toStrictEqual([["Fall 2026 begins", "2026-08-31"], ["Fall 2026 ends", "2027-01-22"]]);
    const felix = await district.ok(district.tokenFor("prn_nf-student-felix"), "me.calendar", { query: { from: "2026-08-01T00:00:00Z", to: "2027-02-01T00:00:00Z" } });
    expect(felix.events.every((e) => e.offeringId === undefined || e.offeringId === "off_nf-math7-fall-p1")).toBe(true);
    expectError(await district.call(district.tokenFor(NF.amara), "me.calendar", { query: { from: "2027-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z" } }), 400, "validation-failed");
  });

  it("is served as iCalendar by a revocable token whose hash alone is stored, without grades or feedback", async () => {
    const { district } = await boot(undefined, "2026-08-25T12:00:00Z");
    const { assignment } = await teacherSetsUpEssay(district);
    const amara = district.tokenFor(NF.amara);
    expect(await district.ok(amara, "me.calendarFeed")).toStrictEqual({ active: false });
    const { token, path } = await district.ok(amara, "me.rotateCalendarFeed");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(path).toBe(calendarFeedPath(token));
    const stored = await district.app.stores.communication.calendarFeeds.get(NF.amara as PrincipalId);
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token);

    const feed = (p: string) => district.app.fetch(new Request(new URL(p, "https://district.example")));
    const response = await feed(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    const ics = await response.text();
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics).toContain(`UID:due-${assignment.id}@dst_northfield.schoolos\r\n`);
    expect(ics).not.toMatch(/grade|feedback|score/i);

    // Rotating ends the old URL; revoking ends the new one. A malformed token is just as unknown.
    const rotated = await district.ok(amara, "me.rotateCalendarFeed");
    expect((await feed(path)).status).toBe(404);
    expect((await feed(rotated.path)).status).toBe(200);
    expect(await district.ok(amara, "me.revokeCalendarFeed")).toStrictEqual({ active: false });
    expect((await feed(rotated.path)).status).toBe(404);
    expect((await feed("/api/calendar/not-a-token.ics")).status).toBe(404);
    expect((await feed("/api/calendar/%E0%A4%A.ics")).status).toBe(404);
    // The feed belongs to Amara alone: Elena's own feed shows her classes, not Amara's token.
    const elena = await district.ok(district.tokenFor(NF.elena), "me.rotateCalendarFeed");
    expect(elena.token).not.toBe(rotated.token);
  });
});

describe("notifications", () => {
  it("tell a student of new announcements and assignments, once, and are marked read", async () => {
    const { district } = await boot();
    await post(district, "Library visit");
    const { assignment } = await teacherSetsUpEssay(district);
    const amara = district.tokenFor(NF.amara);
    const first = await district.ok(amara, "me.notifications");
    expect(first.notifications.map((n) => n.kind).toSorted()).toStrictEqual(["announcement", "assignment-published"]);
    expect(first.unread).toBe(2);
    expect(first.notifications.find((n) => n.kind === "assignment-published")).toMatchObject({ ref: { assignmentId: assignment.id }, title: `New assignment in English 9 (Period 3): ${assignment.title}` });
    // Asking again adds nothing.
    expect((await district.ok(amara, "me.notifications")).notifications).toHaveLength(2);

    expect(await district.ok(amara, "me.markNotificationsRead", { body: { ids: [first.notifications[0]!.id] } })).toStrictEqual({ unread: 1 });
    // Another principal's notification IDs mark nothing of theirs: Elena has her own two.
    expect((await district.ok(district.tokenFor(NF.elena), "me.notifications")).unread).toBe(2);
    expect(await district.ok(district.tokenFor(NF.elena), "me.markNotificationsRead", { body: { ids: [first.notifications[1]!.id] } })).toMatchObject({ unread: 2 });
    expect(await district.ok(amara, "me.markNotificationsRead", { body: { all: true } })).toStrictEqual({ unread: 0 });
    expectError(await district.call(amara, "me.markNotificationsRead", { body: {} }), 400, "validation-failed");
    // Felix is in none of it; teachers get none of these.
    expect((await district.ok(district.tokenFor("prn_nf-student-felix"), "me.notifications")).notifications).toStrictEqual([]);
    expect((await district.ok(district.tokenFor(NF.rivera), "me.notifications")).notifications).toStrictEqual([]);
  });

  it("tell of feedback only once it is released, of grades once official, and remind of unsubmitted work due soon", async () => {
    const { district, clock } = await boot();
    const { assignment } = await teacherSetsUpEssay(district);
    const rivera = district.tokenFor(NF.rivera);
    await district.ok(rivera, "teacher.updateAssignment", { params: { assignmentId: assignment.id }, body: { dueAt: new Date(clock.at.getTime() + DAY).toISOString() } });
    const kinds = async (student: string) => (await district.ok(district.tokenFor(student), "me.notifications")).notifications.map((n) => n.kind).toSorted();
    // Elena has not submitted: she is reminded; Amara has, so she is not.
    const { receipt } = await studentSubmitsEssay(district, assignment.id);
    expect(await kinds(NF.elena)).toStrictEqual(["assignment-due-soon", "assignment-published"]);
    expect(await kinds(NF.amara)).toStrictEqual(["assignment-published"]);

    await district.ok(rivera, "teacher.addComment", { params: { submissionId: receipt.submissionId }, body: { body: "Strong claim." } });
    expect(await kinds(NF.amara)).toStrictEqual(["assignment-published"]);
    await district.ok(rivera, "teacher.releaseFeedback", { params: { submissionId: receipt.submissionId }, body: { state: "shared-with-student" } });
    await district.ok(rivera, "teacher.recordGrade", { params: { submissionId: receipt.submissionId }, body: { score: { points: 9, maxPoints: 10 } } });
    const notified = (await district.ok(district.tokenFor(NF.amara), "me.notifications")).notifications;
    expect(notified.map((n) => n.kind).toSorted()).toStrictEqual(["assignment-published", "feedback-released", "grade-released"]);
    // A notification names the work, never the score or the comment.
    expect(JSON.stringify(notified)).not.toMatch(/Strong claim|"points"|9\/10/);
    expect(await kinds(NF.elena)).toStrictEqual(["assignment-due-soon", "assignment-published"]);
  });

  it("are emailed by the periodic job once, honouring opt-outs, missing addresses and what was already read", async () => {
    const mail = new InMemoryMailSender();
    const { district } = await boot({ mail, appUrl: "https://learn.northfield.example" });
    await post(district, "Library visit");
    let result = await district.app.communication.runNotificationJob();
    // Amara has an address and gets it; Elena and Dmitri have none on file.
    expect(mail.sent.map((m) => [m.to, m.subject])).toStrictEqual([["family.okafor@northfield.example", "New announcement in English 9 (Period 3): Library visit"]]);
    expect(mail.sent[0]!.text).toContain("https://learn.northfield.example");
    expect(result).toMatchObject({ added: 2, emailed: 1, skipped: 1 });
    expect(await district.app.communication.runNotificationJob()).toStrictEqual({ added: 0, emailed: 0, skipped: 0, failed: 0 });

    // Amara opts out of announcement email; a failed send is retried on the next run.
    const amara = district.tokenFor(NF.amara);
    expect(await district.ok(amara, "me.preferences")).toMatchObject({ email: { announcements: true }, hasEmailAddress: true, emailEnabled: true });
    expect((await district.ok(amara, "me.updatePreferences", { body: { email: { announcements: false } } })).email).toMatchObject({ announcements: false, assignments: true });
    await post(district, "Second visit");
    result = await district.app.communication.runNotificationJob();
    expect(result).toMatchObject({ emailed: 0, skipped: 2 });
    await teacherSetsUpEssay(district);
    mail.failing = true;
    expect(await district.app.communication.runNotificationJob()).toMatchObject({ emailed: 0, failed: 1 });
    mail.failing = false;
    expect(await district.app.communication.runNotificationJob()).toMatchObject({ emailed: 1, failed: 0 });
    expect(mail.sent).toHaveLength(2);
  });
});

/**
 * A district with mail, the given guardian relationships, and an essay due Thursday of the coming
 * week. The relationships are recorded in the district's own guardian relationship store (ADR-0012,
 * SCHO-188), the one its guardian routes and policy engine read, which is all the digest goes out over.
 */
async function digestDistrict(relationships: GuardianRelationship[]) {
  const mail = new InMemoryMailSender();
  const { district, clock } = await boot({ mail, appUrl: "https://learn.northfield.example" });
  for (const r of relationships) {
    const target = { relationshipId: r.id, guardianPrincipalId: r.guardianPrincipalId, studentPrincipalId: r.studentPrincipalId };
    await district.app.stores.guardianRelationships.commit(r, { districtId: r.districtId, actor: { principalId: NF.admin as PrincipalId }, action: "guardian-relationship.recorded", target, at: r.created.at }, undefined);
  }
  const { assignment } = await teacherSetsUpEssay(district);
  const rivera = district.tokenFor(NF.rivera);
  // Due Thursday of the coming week.
  await district.ok(rivera, "teacher.updateAssignment", { params: { assignmentId: assignment.id }, body: { dueAt: "2026-10-29T15:00:00Z" } });
  await post(district, "Library <visit> & forms");
  await post(district, "Next month's trip", { publishAt: "2026-11-20T12:00:00Z" });
  await district.ok(rivera, "teacher.setWeeklyNote", { params: { offeringId: NF.eng9 }, body: { text: "Read chapters 1-3." } });
  return { district, clock, mail, assignment };
}

const OKAFOR_AMARA = relationship("grl_okafor-amara", GUARDIAN.okafor, NF.amara);

describe("weekly family digest", () => {
  it("tells a guardian their child's coming week from the child's own view, escaped, once per week", async () => {
    const { district, mail, assignment } = await digestDistrict([OKAFOR_AMARA]);
    // Amara and Elena submit; only Amara's feedback is released, and Elena's is not her guardian's business anyway.
    const { receipt } = await studentSubmitsEssay(district, assignment.id);
    await studentSubmitsEssay(district, assignment.id, district.tokenFor(NF.elena));
    const rivera = district.tokenFor(NF.rivera);
    await district.ok(rivera, "teacher.addComment", { params: { submissionId: receipt.submissionId }, body: { body: "Private comment text" } });

    const preview = await district.ok(district.tokenFor(NF.admin), "admin.previewDigest", { params: { guardianPrincipalId: GUARDIAN.okafor } });
    expect(preview.digest).toMatchObject({ week: "2026-W44", weekOf: "2026-10-26" });
    const [child] = preview.digest.children;
    expect(child).toMatchObject({ studentPrincipalId: NF.amara, displayName: "Amara Okafor" });
    const eng9 = child!.offerings.find((o) => o.offeringId === NF.eng9)!;
    expect(eng9).toMatchObject({
      due: [{ title: assignment.title, dueAt: "2026-10-29T15:00:00.000Z" }],
      announcements: [{ title: "Library <visit> & forms" }],
      // The feedback is still a draft, so it is not the child's, nor the guardian's.
      feedback: [],
      note: "Read chapters 1-3.",
    });
    expect(preview.html).toContain("Library &lt;visit&gt; &amp; forms");
    expect(preview.html).not.toContain("<visit>");
    expect(preview.text).toContain("Library <visit> & forms");
    expect(preview.subject).toBe("Weekly update for Amara Okafor: week of October 26, 2026");
    // The scheduled announcement is not yet the child's, so it is not in the digest.
    expect(preview.text).not.toContain("Next month's trip");

    await district.ok(rivera, "teacher.releaseFeedback", { params: { submissionId: receipt.submissionId }, body: { state: "shared-with-student" } });
    await district.ok(rivera, "teacher.recordGrade", { params: { submissionId: receipt.submissionId }, body: { score: { points: 9, maxPoints: 10 } } });
    expect(await district.app.communication.runWeeklyDigest()).toMatchObject({ week: "2026-W44", sent: 1, skipped: 1 });
    expect(mail.sent).toHaveLength(1);
    const [email] = mail.sent;
    expect(email!.to).toBe("grace.okafor@family.example");
    expect(email!.text).toContain(`New feedback from the teacher on:\n  - ${assignment.title}`);
    // Never the comment, the grade or a sibling's or classmate's work.
    expect(`${email!.text}${email!.html}`).not.toMatch(/Private comment text|9\s*\/\s*10|points|Elena|Chidi/);
    // Running again in the same week sends nothing more.
    expect(await district.app.communication.runWeeklyDigest()).toMatchObject({ sent: 0, alreadyDone: 2 });
    expect(mail.sent).toHaveLength(1);
  });

  it("keeps siblings apart and honours the relationship's offerings, kinds and status", async () => {
    // A relationship to Amara narrowed to Biology, without announcements; none at all to her brother Chidi.
    const narrowed = relationship("grl_okafor-amara", GUARDIAN.okafor, NF.amara, { offeringIds: [NF.bio as never], readableKinds: ["offering", "activity"] });
    const { district } = await digestDistrict([narrowed]);
    await district.ok(district.tokenFor(NF.morgan), "teacher.createAnnouncement", { params: { offeringId: NF.bio }, body: { title: "Lab coats", body: "Bring one." } });
    const preview = await district.ok(district.tokenFor(NF.admin), "admin.previewDigest", { params: { guardianPrincipalId: GUARDIAN.okafor } });
    expect(preview.digest.children).toHaveLength(1);
    expect(preview.digest.children[0]!.offerings.map((o) => o.offeringId)).toStrictEqual([NF.bio]);
    expect(preview.digest.children[0]!.offerings[0]!.announcements).toStrictEqual([]);
    expect(preview.text).not.toMatch(/English 9|Lab coats|Math/);

    // A revoked relationship tells the guardian nothing.
    const revoked = relationship("grl_okafor-amara", GUARDIAN.okafor, NF.amara, { status: "revoked", revoked: { by: NF.admin as never, at: "2026-10-01T00:00:00Z" } });
    const second = await digestDistrict([revoked]);
    const nothing = await second.district.ok(second.district.tokenFor(NF.admin), "admin.previewDigest", { params: { guardianPrincipalId: GUARDIAN.okafor } });
    expect(nothing).toMatchObject({ digest: { children: [] }, empty: true });
    expect(await second.district.app.communication.runWeeklyDigest()).toMatchObject({ sent: 0, skipped: 2 });
    expect(second.mail.sent).toStrictEqual([]);
  });

  it("is previewed by district administrators only, for guardians only", async () => {
    const { district } = await digestDistrict([OKAFOR_AMARA]);
    expectError(await district.call(district.tokenFor(NF.rivera), "admin.previewDigest", { params: { guardianPrincipalId: GUARDIAN.okafor } }), 403, "forbidden");
    expectError(await district.call(district.tokenFor("prn_nf-principal-high"), "admin.previewDigest", { params: { guardianPrincipalId: GUARDIAN.okafor } }), 403, "forbidden");
    expectError(await district.call(district.tokenFor(NF.amara), "admin.previewDigest", { params: { guardianPrincipalId: GUARDIAN.okafor } }), 403, "forbidden");
    expectError(await district.call(district.tokenFor(NF.admin), "admin.previewDigest", { params: { guardianPrincipalId: NF.amara } }), 404, "not-found");
  });

  it("records an opted-out guardian as skipped, and retries a failed send the next run", async () => {
    const { district, mail } = await digestDistrict([OKAFOR_AMARA]);
    mail.failing = true;
    expect(await district.app.communication.runWeeklyDigest()).toMatchObject({ sent: 0, failed: 1 });
    expect(await district.app.stores.communication.digestLedger.get(GUARDIAN.okafor as PrincipalId, "2026-W44")).toMatchObject({ status: "failed" });
    mail.failing = false;
    expect(await district.app.communication.runWeeklyDigest()).toMatchObject({ sent: 1 });
    // Another district instance, with the guardian opted out.
    const next = await digestDistrict([OKAFOR_AMARA]);
    await next.district.app.stores.communication.preferences.put(GUARDIAN.okafor as PrincipalId, { announcements: true, assignments: true, feedback: true, grades: true, digest: false });
    expect(await next.district.app.communication.runWeeklyDigest()).toMatchObject({ sent: 0, skipped: 2 });
    expect(await next.district.app.stores.communication.digestLedger.get(GUARDIAN.okafor as PrincipalId, "2026-W44")).toMatchObject({ status: "skipped", reason: "opted-out" });
  });
});
