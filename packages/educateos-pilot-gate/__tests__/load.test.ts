// H01 smoke-level load: many students working at once through one district app, in process. This
// asserts correctness under concurrency, not speed; timings are recorded as test annotations for
// information only. A request that loses a race answers `conflict` and the client retries it, as
// the API tells it to; anything else, or any write that goes missing, fails the check.
import { expect, type TestContext } from "vitest";
import type { DistrictApiClient } from "@educateos/api-client";
import { DistrictApiError } from "@educateos/api-client";
import { bootHarness } from "@educateos/harness";
import { criterion } from "./gate.ts";
import { applyNorthfieldRoster, bootDistrictFor, MODEL, NF, teacherInstallsEssay, usdNano } from "./support.ts";

/** How many students work at once. */
const STUDENTS = 24;
/** How many revisions each student saves at once. */
const SAVES = 5;
/** How many AI requests each student makes, each sent twice. */
const AI_REQUESTS = 4;

/** A class of {@link STUDENTS} rostered students, each with a client of their own. */
async function busyClass() {
  const [entry] = await bootHarness();
  const district = await bootDistrictFor(entry!);
  const usernames = Array.from({ length: STUDENTS }, (_, i) => `nf-s-${3001 + i}`);
  const { offeringId } = await applyNorthfieldRoster(district, {
    rivera: true,
    students: usernames,
    extraStudents: usernames.map((username, i) => [username, `Student${i + 1}`, "Synthetic"] as const),
  });
  const { assignment, teacher } = await teacherInstallsEssay(district, NF.rivera, offeringId);
  const students = await Promise.all(usernames.map(async (username) => district.withToken(await entry!.identity.issueToken(username))));
  return { district, offeringId, assignment, teacher, students };
}

/** Counts the conflicts concurrent requests are told to retry. */
class Retrier {
  conflicts = 0;

  /** Runs `call`, retrying while it answers `conflict`. Any other error propagates. */
  async run<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call();
      } catch (error) {
        if (!(error instanceof DistrictApiError) || error.code !== "conflict" || attempt >= 50) throw error;
        this.conflicts += 1;
      }
    }
  }
}

async function timed<T>(context: TestContext, label: string, work: () => Promise<T>, detail: () => string = () => ""): Promise<T> {
  const started = performance.now();
  const result = await work();
  await context.annotate(`${label}: ${(performance.now() - started).toFixed(0)} ms ${detail()}`.trim());
  return result;
}

/** Each student opens their course workspace and starts an essay, all at once. */
async function startEssays(students: readonly DistrictApiClient[], offeringId: string, retrier: Retrier) {
  return Promise.all(students.map(async (student, i) => {
    const workspace = await retrier.run(() => student.call("student.openCourseWorkspace", { params: { offeringId } }));
    const { artifact } = await retrier.run(() => student.call("student.createArtifact", {
      body: { workspaceId: workspace.id, type: "document", title: `Essay ${i + 1}`, content: { kind: "text", mediaType: "text/plain", text: `draft 0 of student ${i + 1}` } },
    }));
    return { student, artifact };
  }));
}

/** What student `s`'s request `r` costs: small, varied amounts, so a lost or doubled request shows. */
const cents = (s: number, r: number) => 1 + ((s * 7 + r * 3) % 9);
const costOf = (s: number) => Array.from({ length: AI_REQUESTS }, (_, r) => cents(s, r)).reduce((a, b) => a + b, 0);

const draft = (student: number, n: number) => `draft ${n} of student ${student + 1}: school should start later, and here is why.`;

criterion("h01.load", {
  saves: async (context) => {
    const { offeringId, students } = await busyClass();
    const retrier = new Retrier();
    const essays = await timed(context, `${STUDENTS} students open a workspace and start an essay`, () => startEssays(students, offeringId, retrier));
    await timed(context, `${STUDENTS * SAVES} concurrent saves`, () => Promise.all(essays.flatMap(({ student, artifact }, i) =>
      Array.from({ length: SAVES }, (_, n) => retrier.run(() => student.call("student.saveRevision", {
        params: { artifactId: artifact.id },
        body: { content: { kind: "text", mediaType: "text/plain", text: draft(i, n + 1) } },
      }))))), () => `(${retrier.conflicts} conflict retries)`);

    // Every save is in its artifact's history, numbered without gaps, with exactly its text.
    for (const [i, { student, artifact }] of essays.entries()) {
      const history = await student.call("student.artifactHistory", { params: { artifactId: artifact.id } });
      expect(history.map((r) => r.number).toSorted((a, b) => a - b)).toStrictEqual(Array.from({ length: SAVES + 1 }, (_, n) => n + 1));
      const texts = await Promise.all(history.map(async (revision) => {
        const { content } = await student.call("student.getArtifact", { params: { artifactId: artifact.id }, query: { revisionId: revision.id } });
        return content.kind === "text" ? content.text : "";
      }));
      expect(texts.toSorted()).toStrictEqual([`draft 0 of student ${i + 1}`, ...Array.from({ length: SAVES }, (_, n) => draft(i, n + 1))].toSorted());
    }
  },

  submits: async (context) => {
    const { district, offeringId, assignment, teacher, students } = await busyClass();
    const retrier = new Retrier();
    const essays = await startEssays(students, offeringId, retrier);
    const heads = await Promise.all(essays.map(async ({ student, artifact }) => ({
      student,
      artifact,
      head: (await student.call("student.artifactHistory", { params: { artifactId: artifact.id } }))[0]!,
    })));
    const receipts = await timed(context, `${STUDENTS * 3} concurrent submits (three per student)`, () => Promise.all(heads.map(({ student, artifact, head }) =>
      Promise.all(Array.from({ length: 3 }, () => retrier.run(() => student.call("student.submit", {
        params: { assignmentId: assignment.id },
        body: { revisions: [{ artifactId: artifact.id, revisionId: head.id }] },
      })))))), () => `(${retrier.conflicts} conflict retries)`);

    // Submitting the same work again is the same submission, so each student has exactly one.
    for (const attempts of receipts) {
      expect(new Set(attempts.map((r) => r.submissionId)).size).toBe(1);
      expect(attempts.every((r) => r.attempt === 1)).toBe(true);
    }
    const submissions = await teacher.call("teacher.listSubmissions", { params: { assignmentId: assignment.id } });
    expect(submissions).toHaveLength(STUDENTS);
    expect(new Set(submissions.map((s) => s.studentPrincipalId)).size).toBe(STUDENTS);
    expect((await (await district.as(NF.admin)).call("admin.health")).work.submissions).toBe(STUDENTS);
  },

  ledger: async (context) => {
    const { district, offeringId } = await busyClass();
    const { snapshot } = await district.stores.directory.load();
    const studentIds = snapshot.enrollments.filter((e) => e.offeringId === offeringId && e.role === "student" && e.status === "active").map((e) => e.principalId);
    expect(studentIds).toHaveLength(STUDENTS);
    const governor = district.app.aiGovernor;

    // Each request is sent twice at once, as a client retrying a timeout would, and settled twice.
    await timed(context, `${STUDENTS * AI_REQUESTS * 2} concurrent AI requests (each sent twice)`, () => Promise.all(studentIds.flatMap((principalId, s) =>
      Array.from({ length: AI_REQUESTS }, async (_, r) => {
        const request = {
          requestId: `load-${s}-${r}`,
          principal: { principalId, districtId: district.app.districtId },
          workspace: { kind: "course" as const, offeringId },
          model: MODEL,
          estimatedMaxUsdNano: usdNano(10),
        };
        const decisions = await Promise.all([governor.beforeRequest(request), governor.beforeRequest(request)]);
        expect(decisions.map((d) => d.effect)).toStrictEqual(["allow", "allow"]);
        const settle = { status: "completed" as const, requestId: request.requestId, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, actualUsdNano: usdNano(cents(s, r)) };
        await Promise.all([governor.afterResponse(settle), governor.afterResponse(settle)]);
      }))));

    const report = await (await district.as(NF.admin)).call("admin.aiUsage") as {
      district: { requests: number; totalUsdNano: string };
      byPrincipal: Record<string, { requests: number; totalUsdNano: string }>;
    };
    const expectedTotal = studentIds.reduce((sum, _id, s) => sum + costOf(s), 0);
    expect(report.district).toMatchObject({ requests: STUDENTS * AI_REQUESTS, totalUsdNano: usdNano(expectedTotal) });
    for (const [s, principalId] of studentIds.entries()) {
      expect(report.byPrincipal[principalId]).toMatchObject({ requests: AI_REQUESTS, totalUsdNano: usdNano(costOf(s)) });
    }
  },
});
