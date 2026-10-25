import { DistrictDirectorySnapshot } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { describe, expect, it } from "vitest";
import { codexCollectionKey, helperInstructions, InMemoryCodexPublisher, StudentCodex } from "../src/index.ts";
import {
  BIO,
  BIO_SPRING,
  biologyLab,
  CHEN,
  CHIDI,
  D,
  ELENA,
  ENG9,
  HISTORY,
  HOSTILE_TITLE,
  historySources,
  MATH7,
  mathProblems,
  MORGAN,
  PAGES,
  PATEL,
  policyEngine,
  rejectsWith,
  RIVERBEND_TEACHER,
  setup,
} from "./helpers.ts";

/** Every string a teacher marked teacher-only in the fixtures below. */
const TEACHER_ONLY = ["ANSWER-KEY-1", "ANSWER-KEY-2", "TEACHER ONLY", "Grading notes"];

const expectNoTeacherOnly = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const secret of TEACHER_ONLY) expect(text).not.toContain(secret);
};

describe("teacher-only Codex entries never reach students", () => {
  it("keeps answer keys and teacher-only notes and resources out of every student surface", async () => {
    const { service, publisher, release } = await setup();
    const guide = await release(PATEL, PAGES.essay, MATH7);
    const input = mathProblems({
      resources: [guide],
      codex: [
        { kind: "resource", resource: guide, visibility: "teacher-only" },
        { kind: "note", id: "grading", title: "Grading notes", body: "Accept equivalent fractions.", purpose: "context", visibility: "teacher-only" },
        { kind: "note", id: "hint", title: "Hint", body: "A proportional graph passes through the origin.", purpose: "context", visibility: "students" },
      ],
    });
    const definition = await service.publish(PATEL, (await service.createDraft(PATEL, { scope: MATH7, activity: input })).id);
    const installation = await service.install(PATEL, { definitionId: definition.id, offering: MATH7 });

    // The teacher's class Codex has everything, in order, the generated answer key last.
    const classCodex = await service.getClassCodex(PATEL, installation.id);
    expect(classCodex.entries.map((e) => (e.kind === "note" ? e.id : e.kind))).toStrictEqual(["resource", "grading", "hint", "answer-key"]);
    expect(JSON.stringify(classCodex)).toContain("ANSWER-KEY-1");

    const published = publisher.documents(codexCollectionKey(D, MATH7.offeringId));
    expect(published).toHaveLength(1);
    expect(published[0]!.entries).toStrictEqual([
      { kind: "note", id: "hint", title: "Hint", body: "A proportional graph passes through the origin.", purpose: "context", visibility: "students" },
    ]);
    expectNoTeacherOnly(published);
    expectNoTeacherOnly(await service.getStudentCodex(CHIDI, installation.id));
    expectNoTeacherOnly(await service.getActivity(CHIDI, installation.id));
    expectNoTeacherOnly(await service.helperContext(CHIDI, installation.id));
    expect(published[0]!.entries.some((e) => e.kind === "resource")).toBe(false);
  });

  it("refuses an answer key marked visible to students", async () => {
    const { service } = await setup();
    const input = mathProblems({
      codex: [{ kind: "note", id: "key", title: "Key", body: "ANSWER-KEY-1", purpose: "answer-key", visibility: "students" }],
    });
    await rejectsWith(service.createDraft(PATEL, { scope: MATH7, activity: input }), "validation-failed", /always teacher-only/);
  });

  it("has a publisher that refuses anything teacher-only, whoever calls it", async () => {
    const publisher = new InMemoryCodexPublisher();
    const codex = { districtId: D, offeringId: MATH7.offeringId, activityId: "act_x", definitionId: "adf_x", definitionVersion: 1 };
    const leak = { kind: "note", id: "key", title: "Key", body: "ANSWER-KEY-1", purpose: "answer-key", visibility: "teacher-only" };
    await rejectsWith(publisher.publish({ ...codex, entries: [leak] } as unknown as StudentCodex), "validation-failed");
    await rejectsWith(publisher.publish({ ...codex, entries: [{ ...leak, purpose: "context" }] } as unknown as StudentCodex), "validation-failed");
    expect(publisher.documents(codexCollectionKey(D, MATH7.offeringId))).toStrictEqual([]);
  });
});

describe("imported resource text stays in data slots", () => {
  it("never puts a resource's text in the helper's instructions, and cannot close the data block", async () => {
    const { service, release } = await setup();
    const hostile = await release(CHEN, PAGES.hostile, HISTORY);
    const letter = await release(CHEN, PAGES.letter, HISTORY);
    const definition = await service.publish(CHEN, (await service.createDraft(CHEN, { scope: HISTORY, activity: historySources([hostile, letter]) })).id);
    const installation = await service.install(CHEN, { definitionId: definition.id, offering: HISTORY });

    // The release keeps the page's title as imported, and the student Codex carries it as data.
    const codex = await service.getStudentCodex(ELENA, installation.id);
    expect(codex.entries[0]).toMatchObject({ kind: "resource", title: HOSTILE_TITLE });

    const context = await service.helperContext(ELENA, installation.id);
    expect(context.instructions).toBe(helperInstructions("hints-only"));
    expect(context.instructions).not.toMatch(/Ignore all previous|Voices of 1863/);
    const opening = `<class-context boundary="${context.boundary}">\n`;
    const closing = `\n</class-context boundary="${context.boundary}">`;
    expect(context.data.startsWith(opening) && context.data.endsWith(closing)).toBe(true);
    const body = context.data.slice(opening.length, -closing.length);
    expect(body).not.toContain("<");
    const payload = JSON.parse(body) as { codex: { origin: string; title: string }[]; activity: { origin: string } };
    expect(payload.codex[0]).toMatchObject({ origin: "imported", title: HOSTILE_TITLE });
    expect(payload.activity.origin).toBe("teacher-authored");
    // A fresh boundary per request, so content cannot be written against a known one.
    expect((await service.helperContext(ELENA, installation.id)).boundary).not.toBe(context.boundary);
  });

  it("offers no helper when the activity turns AI help off", async () => {
    const { service, release } = await setup();
    const lab = await release(MORGAN, PAGES.cells, BIO);
    const definition = await service.publish(MORGAN, (await service.createDraft(MORGAN, { scope: BIO, activity: biologyLab(lab, { aiHelp: "none" }) })).id);
    const installation = await service.install(MORGAN, { definitionId: definition.id, offering: BIO });
    expect(installation.aiHelp).toBe("none");
    await rejectsWith(service.helperContext(ELENA, installation.id), "policy-violation");
  });
});

const request = (subject: { principalId: string; districtId: string }, action: string, scope: object, extra: object = {}) => ({
  subject,
  action,
  resource: { kind: "activity", scope, classification: "teacher-only" },
  context: { channel: "http", ...extra },
});

describe("activity rules in the district policy engine (SCHO-87)", () => {
  it("refuses installation into a term that is not open, even for its teacher", async () => {
    // A test-only grant: Morgan teaches the completed spring section.
    const directory = DistrictDirectorySnapshot.parse({
      ...NORTHFIELD,
      roleAssignments: [...NORTHFIELD.roleAssignments, { principalId: MORGAN.principalId, role: "teacher", scope: BIO_SPRING, source: "local-grant" }],
    });
    const { engine } = policyEngine(directory);
    expect(await engine.decide(request(MORGAN, "assign", BIO_SPRING, { termState: "completed" }))).toMatchObject({
      decision: { effect: "deny", reason: "term-not-active" },
      ruleId: "guard.term-completed.read-only",
    });
    expect(await engine.decide(request(MORGAN, "assign", BIO_SPRING))).toMatchObject({
      decision: { effect: "deny", reason: "term-not-active" },
      ruleId: "curriculum.activity.install-needs-open-term",
    });
    expect(await engine.decide(request(MORGAN, "assign", BIO, { termState: "grading" }))).toMatchObject({ decision: { effect: "deny", reason: "term-not-active" } });
    expect(await engine.decide(request(MORGAN, "assign", BIO, { termState: "active" }))).toMatchObject({
      decision: { effect: "allow" },
      ruleId: "curriculum.activity.teacher-install",
    });

    const { service, release } = await setup({ directory });
    const lab = await release(MORGAN, PAGES.cells, BIO);
    const definition = await service.publish(MORGAN, (await service.createDraft(MORGAN, { scope: BIO, activity: biologyLab(lab) })).id);
    await rejectsWith(service.install(MORGAN, { definitionId: definition.id, offering: BIO_SPRING }), "forbidden");
  });

  it("denies other districts, forged fields, unknown offerings and definitions to students", async () => {
    const { engine, audit } = policyEngine(NORTHFIELD);
    expect(await engine.authorize(request(RIVERBEND_TEACHER, "read", BIO))).toStrictEqual({ effect: "deny", reason: "cross-district" });
    expect(await engine.authorize({ ...request(MORGAN, "read", BIO), role: "teacher" })).toStrictEqual({ effect: "deny", reason: "invalid-request" });
    // An offering that is not in the directory, even one a district-wide grant would contain.
    const invented = { ...BIO, offeringId: "off_nf-invented" };
    expect(await engine.decide(request(MORGAN, "read", invented))).toMatchObject({ decision: { effect: "deny" }, ruleId: "scope.unknown" });
    // A student in Biology reads only course-classified activities there.
    expect(await engine.decide(request({ principalId: "prn_nf-student-amara", districtId: D }, "read", BIO))).toMatchObject({
      decision: { effect: "deny", reason: "classification-restricted" },
      ruleId: "curriculum.activity.definition-staff-only",
    });
    expect(audit.events.map((e) => e.ruleId)).toStrictEqual([
      "precheck.cross-district",
      "precheck.invalid-request",
      "scope.unknown",
      "curriculum.activity.definition-staff-only",
    ]);
  });

  it("lets a co-teacher read a class's definitions but not author, publish or install them", async () => {
    const { engine } = policyEngine(NORTHFIELD);
    expect((await engine.authorize(request(CHEN, "read", ENG9))).effect).toBe("allow");
    for (const action of ["create", "update", "publish"]) {
      expect((await engine.authorize(request(CHEN, action, ENG9))).effect).toBe("deny");
    }
    expect((await engine.authorize(request(CHEN, "assign", ENG9, { termState: "active" }))).effect).toBe("deny");
  });
});
