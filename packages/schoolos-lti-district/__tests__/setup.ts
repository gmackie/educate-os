import { expect } from "vitest";
import {
  ActivityId,
  DistrictId,
  OfferingId,
  PrincipalId,
  SchoolOsError,
  type AuthorityMap,
  type Caller,
  type DistrictDirectorySnapshot,
  type PolicySettings,
} from "@schoolos/contracts";
import { InMemoryAcademicStore } from "@schoolos/academics";
import { InMemoryAssessmentRecordStore, type AssessmentState } from "@schoolos/assessment";
import { NORTHFIELD } from "@schoolos/fixtures";
import { DynamicRegistration, type PlatformRegistration } from "@schoolos/lti";
import { directoryPolicyInformation, PolicyEngine, type PolicyAuditEvent } from "@schoolos/policy";
import {
  createLtiDistrictStores,
  directoryRegistrationTargets,
  InMemoryRecordTable,
  LtiAdminService,
  type ActivityCatalog,
  type CatalogActivity,
} from "../src/index.ts";

export const NF = DistrictId.parse("dst_northfield");
export const NF_CANVAS = "https://canvas.northfield.example";
export const TOOL = "https://schoolos.example";
export const BIO = OfferingId.parse("off_nf-bio-fall-p2");
export const ENG9 = OfferingId.parse("off_nf-eng9-fall-p3");
export const MATH7 = OfferingId.parse("off_nf-math7-fall-p1");
export const BIO_CONTEXT = "nf-canvas-course-bio-p2";
export const CELL_LAB = ActivityId.parse("act_cell-lab");
export const ESSAY = ActivityId.parse("act_eng9-essay");

export const ADMIN = PrincipalId.parse("prn_nf-district-admin");
export const SCHOOL_ADMIN = PrincipalId.parse("prn_nf-principal-high");
export const MORGAN = PrincipalId.parse("prn_nf-morgan-lee");
export const RIVERA = PrincipalId.parse("prn_nf-teacher-rivera");
export const PATEL = PrincipalId.parse("prn_nf-teacher-patel");
export const AMARA = PrincipalId.parse("prn_nf-student-amara");
export const DMITRI = PrincipalId.parse("prn_nf-student-dmitri");
export const ELENA = PrincipalId.parse("prn_nf-student-elena");
export const FELIX = PrincipalId.parse("prn_nf-student-felix");

/** Each principal's Canvas `sub`. */
export const SUBJECTS: Record<string, string> = {
  [AMARA]: "lti-amara",
  [DMITRI]: "lti-dmitri",
  [ELENA]: "lti-elena",
  [FELIX]: "lti-felix",
  [MORGAN]: "lti-morgan",
  [RIVERA]: "lti-rivera",
  [ADMIN]: "lti-admin",
};

/** Northfield on Canvas: the issuer is trusted and the people above are linked to their subjects. */
export const NORTHFIELD_CANVAS: DistrictDirectorySnapshot = {
  ...NORTHFIELD,
  district: { ...NORTHFIELD.district, trustedIssuers: [...NORTHFIELD.district.trustedIssuers, NF_CANVAS] },
  principals: NORTHFIELD.principals.map((p) => {
    const subject = SUBJECTS[p.id];
    return subject === undefined ? p : { ...p, externalIdentities: [...p.externalIdentities, { districtId: NF, issuer: NF_CANVAS, subject }] };
  }),
};

/** Enrollments belong to Canvas; everything else is SchoolOS's. */
export const CANVAS_ENROLLMENTS: AuthorityMap = {
  school: "local",
  term: "local",
  course: "local",
  offering: "local",
  enrollment: "external:canvas",
  principal: "local",
};

/** Northfield's Canvas registration, as an administrator approved it. */
export function canvasRegistration(overrides: Partial<PlatformRegistration> = {}): PlatformRegistration {
  return {
    districtId: NF,
    provider: "canvas",
    issuer: NF_CANVAS,
    clientId: "10000000000001",
    deploymentIds: ["nf-canvas-deploy-1"],
    authLoginUrl: `${NF_CANVAS}/api/lti/authorize_redirect`,
    authTokenUrl: `${NF_CANVAS}/login/oauth2/token`,
    jwksUrl: `${NF_CANVAS}/api/lti/security/jwks`,
    offerings: [
      { contextId: BIO_CONTEXT, offeringId: BIO },
      { contextId: "nf-canvas-course-eng9-p3", offeringId: ENG9 },
    ],
    activityLinks: [],
    ...overrides,
  };
}

/** Installed activities: the cell lab in Biology, the essay in English 9. */
export class FakeActivityCatalog implements ActivityCatalog {
  readonly activities = new Map<string, CatalogActivity>([
    [CELL_LAB, { scope: { level: "activity", districtId: NF, schoolId: "sch_nf-high", offeringId: BIO, activityId: CELL_LAB } as CatalogActivity["scope"], title: "Cell lab" }],
    [ESSAY, { scope: { level: "activity", districtId: NF, schoolId: "sch_nf-high", offeringId: ENG9, activityId: ESSAY } as CatalogActivity["scope"], title: "Personal essay" }],
  ]);

  async find(activityId: ActivityId): Promise<CatalogActivity | undefined> {
    return this.activities.get(activityId);
  }
}

const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "shared-by-student",
  teacherObservation: "assigned-work-and-shared-conversations",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};

/** A test clock. */
export class TestClock {
  ms = Date.UTC(2026, 9, 21, 9, 0, 0);
  readonly now = (): number => this.ms;
}

/** The caller a principal is, through the HTTP surface. */
export const as = (principalId: PrincipalId): Caller => ({ principal: { principalId, districtId: NF }, channel: "http" });

/** Northfield's LTI district state: directory, policy engine, stores and admin service. */
export function createDistrict(directory: DistrictDirectorySnapshot = NORTHFIELD_CANVAS) {
  const clock = new TestClock();
  const academics = InMemoryAcademicStore.seeded(directory);
  const audit: PolicyAuditEvent[] = [];
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(academics, { effectivePolicy: async () => FLOOR }),
    audit: { record: async (event) => void audit.push(event) },
  });
  const activities = new FakeActivityCatalog();
  const loadDirectory = async () => (await academics.load()).snapshot;
  const targets = directoryRegistrationTargets({ districtId: NF, directory: loadDirectory, activities });
  const table = new InMemoryRecordTable();
  const stores = createLtiDistrictStores(table, { targets, now: clock.now });
  const assessments = new InMemoryAssessmentRecordStore();
  const platformFetch: { handler: (request: Request) => Promise<Response> } = { handler: async () => new Response(null, { status: 404 }) };
  const dynamicRegistration = new DynamicRegistration({
    toolOrigin: TOOL,
    toolName: "SchoolOS",
    invitations: stores.invitations,
    pending: stores.pendingRegistrations,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => platformFetch.handler(new Request(input, init))) as typeof fetch,
    now: clock.now,
  });
  const admin = new LtiAdminService({
    districtId: NF,
    authorizer: engine,
    directory: loadDirectory,
    dynamicRegistration,
    pending: stores.pendingRegistrations,
    registrations: stores.registrations,
    contextServices: stores.contextServices,
    gradeRoutes: stores.gradeRoutes,
    gradeColumns: stores.gradeColumns,
    assessments,
  });
  return { clock, academics, engine, audit, activities, targets, table, stores, assessments, platformFetch, dynamicRegistration, admin, loadDirectory };
}

/** A district from {@link createDistrict}. */
export type District = ReturnType<typeof createDistrict>;

/** The code of the `SchoolOsError` a promise rejects with. */
export async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SchoolOsError);
    return (err as SchoolOsError).code;
  }
  throw new Error("expected a rejection");
}

/** An assessment state with one Biology assignment and Amara's teacher-approved grade, version 1. */
export function gradedBiology(): AssessmentState {
  return {
    assignments: [
      {
        id: "asg_cell-lab" as never,
        districtId: NF,
        offeringId: BIO,
        activityId: CELL_LAB,
        title: "Cell lab",
        dueAt: "2026-10-25T23:59:00Z",
        latePolicy: { kind: "refuse" },
        attemptsAllowed: 1,
        permittedArtifactTypes: ["document"],
        feedbackVisibility: "when-shared",
        createdBy: MORGAN,
        createdAt: "2026-10-01T09:00:00Z",
        updatedAt: "2026-10-01T09:00:00Z",
      },
    ],
    starterMaterials: [],
    submissions: [],
    feedback: [],
    gradeProposals: [],
    gradeVersions: [
      {
        format: "schoolos.official-grade.v1",
        districtId: NF,
        offeringId: BIO,
        assignmentId: "asg_cell-lab" as never,
        studentPrincipalId: AMARA,
        submissionId: "sub_amara-cell-lab" as never,
        submissionDigest: `sha256:${"a".repeat(64)}` as never,
        version: 1,
        score: { points: 8, maxPoints: 10 },
        approval: { approvedBy: MORGAN, approvedAt: "2026-10-20T15:00:00Z", channel: "http" },
      },
    ],
  };
}
