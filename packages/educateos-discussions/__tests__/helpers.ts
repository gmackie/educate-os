import { InMemoryAcademicStore } from "@educateos/academics";
import { DistrictId, PrincipalId, EducateOsError, type PolicySettings, type VerifiedPrincipal } from "@educateos/contracts";
import { InMemoryCourseContentStorage, type CourseOutline } from "@educateos/curriculum";
import { NORTHFIELD } from "@educateos/fixtures";
import { directoryPolicyInformation, InMemoryPolicyAuditSink, PolicyEngine } from "@educateos/policy";
import type { Decision, EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import { DiscussionService, InMemoryDiscussionStorage, type DiscussionScreening } from "../src/index.ts";

export const D = DistrictId.parse("dst_northfield");
export const BIO = "off_nf-bio-fall-p2"; // Morgan teaches; Amara, Dmitri and Elena enrolled
export const BIO_SPRING = "off_nf-bio-spring-p4"; // a completed term
export const ENG9 = "off_nf-eng9-fall-p3"; // Rivera teaches; Dmitri dropped

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
export const ADMIN = subject("prn_nf-district-admin");
export const AMARA = subject("prn_nf-student-amara");
export const ELENA = subject("prn_nf-student-elena");
export const DMITRI = subject("prn_nf-student-dmitri");
export const CHIDI = subject("prn_nf-student-chidi");
export const KAI = subject("prn_rb-student-kai", DistrictId.parse("dst_riverbend"));

export const ASSIGNMENT = "asg_bio-participation";

/**
 * A stand-in for Hall Monitor's `evaluate`: allows everything unless the text carries a marker,
 * `[[block]]`, `[[support]]`, `[[hold]]` or `[[coach]]`, or `[[down]]` to fail as unreachable.
 */
export function fakeHallMonitor() {
  const requests: EvaluationRequest[] = [];
  const screening: DiscussionScreening = {
    settings: { tenantId: "tenant-nf", profileId: "student-9-12", revision: "rev-1", costCenterId: "cc-safety" },
    hallMonitor: {
      async evaluate(request) {
        requests.push(request);
        const text = request.content.type === "text" ? request.content.text : "";
        if (text.includes("[[down]]")) throw new Error("unavailable");
        const decision = (["block", "support", "hold", "coach"] as const).find((d) => text.includes(`[[${d}]]`)) ?? ("allow" satisfies Decision);
        return { decision, reasonCodes: decision === "allow" ? [] : [`moderation.${decision}`] };
      },
    },
  };
  return { screening, requests };
}

/** A discussion service over Northfield, with Biology's course content and one assignment. */
export function setup(options: { screening?: DiscussionScreening; outline?: CourseOutline } = {}) {
  const audit = new InMemoryPolicyAuditSink();
  const engine = new PolicyEngine({ information: directoryPolicyInformation(InMemoryAcademicStore.seeded(NORTHFIELD), { effectivePolicy: async () => FLOOR }), audit });
  const storage = new InMemoryDiscussionStorage();
  const courseContent = new InMemoryCourseContentStorage();
  let clock = 0;
  const service = new DiscussionService({
    districtId: D,
    directory: NORTHFIELD,
    authorizer: engine,
    storage,
    courseContent,
    assignmentsIn: async (offeringId) => (offeringId === BIO ? [ASSIGNMENT] : []),
    ...(options.screening === undefined ? {} : { screening: options.screening }),
    now: () => new Date(Date.parse("2026-10-23T12:00:00.000Z") + clock++ * 1000).toISOString(),
  });
  return { service, storage, courseContent, audit };
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
