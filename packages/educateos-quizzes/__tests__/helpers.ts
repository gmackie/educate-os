import { InMemoryAcademicStore } from "@educateos/academics";
import { DistrictId, OfferingId, PrincipalId, EducateOsError, type PolicySettings, type VerifiedPrincipal } from "@educateos/contracts";
import { InMemoryCourseContentStorage } from "@educateos/curriculum";
import { NORTHFIELD } from "@educateos/fixtures";
import { directoryPolicyInformation, InMemoryPolicyAuditSink, PolicyEngine } from "@educateos/policy";
import { InMemoryQuizStorage, QuizService, type AnswerSheet, type GradeToRecord, type QuizAssignment, type QuizGrading, type QuizItemDraft } from "../src/index.ts";
import { ITEMS } from "./items.ts";

export { ITEMS, RIGHT } from "./items.ts";

export const D = DistrictId.parse("dst_northfield");
export const BIO = "off_nf-bio-fall-p2"; // Morgan teaches; Amara, Dmitri and Elena enrolled
export const BIO_SPRING = "off_nf-bio-spring-p4"; // a completed term
export const ENG9 = "off_nf-eng9-fall-p3"; // Rivera teaches, Chen co-teaches; Amara and Elena enrolled, Dmitri dropped

const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "private",
  teacherObservation: "assigned-work-only",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};

const subject = (id: string, districtId = D): VerifiedPrincipal => ({ principalId: PrincipalId.parse(id), districtId });

export const MORGAN = subject("prn_nf-morgan-lee");
export const RIVERA = subject("prn_nf-teacher-rivera");
export const CHEN = subject("prn_nf-teacher-chen");
export const ADMIN = subject("prn_nf-district-admin");
export const AMARA = subject("prn_nf-student-amara");
export const ELENA = subject("prn_nf-student-elena");
export const DMITRI = subject("prn_nf-student-dmitri");
export const CHIDI = subject("prn_nf-student-chidi");
export const KAI = subject("prn_rb-student-kai", DistrictId.parse("dst_riverbend"));

export const ASSIGNMENT = "asg_bio-quiz";
export const ENG_ASSIGNMENT = "asg_eng-quiz";

/** The start of the test clock. */
export const T0 = Date.parse("2026-10-23T12:00:00.000Z");

/** A grading port that records what it was asked, standing in for the assessment records. */
export function fakeGrading(options: { closesAt?: string } = {}) {
  const sheets: { subject: string; assignmentId: string; sheet: AnswerSheet }[] = [];
  const recorded: { subject: string; grades: readonly GradeToRecord[] }[] = [];
  const prepared: { assignmentId: string; attemptsAllowed: number }[] = [];
  const created: { subject: string; offeringId: string; quizId: string; title: string; assignmentId: string }[] = [];
  const versions = new Map<string, number>();
  const grading: QuizGrading = {
    async assignment(offeringId, assignmentId): Promise<QuizAssignment | undefined> {
      if (offeringId === BIO && assignmentId === ASSIGNMENT) return { id: ASSIGNMENT, title: "Cells quiz", ...(options.closesAt === undefined ? {} : { closesAt: options.closesAt }) };
      if (offeringId === ENG9 && assignmentId === ENG_ASSIGNMENT) return { id: ENG_ASSIGNMENT, title: "Poetry quiz" };
      const own = created.find((c) => c.offeringId === offeringId && c.assignmentId === assignmentId);
      return own === undefined ? undefined : { id: own.assignmentId, title: own.title };
    },
    async createAssignment(who, offeringId, quiz) {
      const assignmentId = `asg_for-${quiz.id.slice(3)}`;
      if (!created.some((c) => c.assignmentId === assignmentId)) created.push({ subject: who.principalId, offeringId, quizId: quiz.id, title: quiz.title, assignmentId });
      return assignmentId;
    },
    async prepareAssignment(_subject, assignmentId, attemptsAllowed) {
      prepared.push({ assignmentId, attemptsAllowed });
    },
    async submitAnswerSheet(who, assignmentId, sheet) {
      sheets.push({ subject: who.principalId, assignmentId, sheet });
      return `sub_${sheet.attemptId.slice(4)}`;
    },
    async recordGrades(who, grades) {
      recorded.push({ subject: who.principalId, grades });
      // The class's teacher makes grades official; a co-teacher's wait for approval, as the gate decides.
      if (who.principalId === CHEN.principalId) return grades.map(() => ({ status: "pending-approval" as const }));
      return grades.map((g) => {
        const version = (versions.get(g.submissionId) ?? 0) + 1;
        versions.set(g.submissionId, version);
        return { status: "official" as const, version };
      });
    },
  };
  return { grading, sheets, recorded, prepared, created };
}

/** A quiz service over Northfield, on a clock tests move, with Biology's assignment. */
export function setup(options: { closesAt?: string } = {}) {
  const audit = new InMemoryPolicyAuditSink();
  const engine = new PolicyEngine({ information: directoryPolicyInformation(InMemoryAcademicStore.seeded(NORTHFIELD), { effectivePolicy: async () => FLOOR }), audit });
  const storage = new InMemoryQuizStorage();
  const courseContent = new InMemoryCourseContentStorage();
  const clock = { at: T0 };
  const fake = fakeGrading(options);
  const service = new QuizService({
    districtId: D,
    directory: NORTHFIELD,
    authorizer: engine,
    storage,
    courseContent,
    grading: fake.grading,
    now: () => new Date(clock.at).toISOString(),
  });
  /** Moves the clock on by `ms`. */
  const advance = (ms: number) => {
    clock.at += ms;
  };
  return { service, storage, courseContent, audit, clock, advance, ...fake, offering: OfferingId.parse(BIO) };
}

/** A published Biology quiz with every item type. */
export async function publishedQuiz(service: QuizService, settings: Record<string, unknown> = {}, items: readonly QuizItemDraft[] = Object.values(ITEMS)) {
  const quiz = await service.createQuiz(MORGAN, BIO, {
    title: "Cells quiz",
    assignmentId: ASSIGNMENT,
    items,
    settings: { attemptsAllowed: 2, shuffleQuestions: false, shuffleChoices: false, showAnswers: "after-release", scorePolicy: "best", ...settings },
  });
  return service.setPublished(MORGAN, BIO, quiz.id, { published: true });
}

/** The error code a promise rejects with, or `resolved`. */
export async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EducateOsError) return error.code;
    throw error;
  }
  return "resolved";
}

/** The message a promise rejects with. */
export async function message(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  return "resolved";
}
