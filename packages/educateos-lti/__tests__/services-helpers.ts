import { DistrictId, OfferingId, PrincipalId, type DistrictDirectorySnapshot } from "@educateos/contracts";
import {
  AgsClient,
  GradePassback,
  InMemoryGradeApprovalStore,
  InMemoryGradeRouteStore,
  InMemoryPassbackLedger,
  LtiAgsGradeSink,
  LtiServiceClient,
  NrpsClient,
  toolJwks,
  type GradeRoute,
  type GradeSink,
  type TeacherGradeApproval,
} from "../src/index.ts";
import { FakeServicePlatform, servicesFetch } from "./fake-services.ts";
import { createWorld, NORTHFIELD_LTI } from "./helpers.ts";

/** Northfield Biology, period 2, as its Canvas course. */
export const BIO_CONTEXT = "nf-canvas-course-bio-p2";
export const BIO = OfferingId.parse("off_nf-bio-fall-p2");
export const ENG9 = OfferingId.parse("off_nf-eng9-fall-p3");
/** Amara's Canvas `sub`. */
export const AMARA_SUB = "lti-user-0007";
export const AMARA = PrincipalId.parse("prn_nf-student-amara");
/** Teaches Biology, period 2. */
export const MORGAN = PrincipalId.parse("prn_nf-morgan-lee");
/** Teaches English 9, not Biology. */
export const RIVERA = PrincipalId.parse("prn_nf-teacher-rivera");

/** A broker world plus the Northfield Canvas's LTI Advantage services and every service client. */
export async function createServicesWorld(
  options: { routes?: (canvas: FakeServicePlatform) => GradeRoute[]; directory?: DistrictDirectorySnapshot; sinks?: GradeSink[] } = {},
) {
  const world = await createWorld();
  const canvas = new FakeServicePlatform(world.platforms.nfCanvas, () => toolJwks(world.getToolKeys()), world.clock.now);
  const fetched: string[] = [];
  const routed = servicesFetch([canvas]);
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetched.push(new Request(input, init).url);
    return routed(input, init);
  }) as typeof globalThis.fetch;

  const services = new LtiServiceClient({ fetch, toolKeys: world.getToolKeys, now: world.clock.now });
  const nrps = new NrpsClient({ services, registrations: world.registrations, now: world.clock.now });
  const ags = new AgsClient({ services, registrations: world.registrations });
  const approvals = new InMemoryGradeApprovalStore();
  const ledger = new InMemoryPassbackLedger();
  const routes = new InMemoryGradeRouteStore(
    options.routes?.(canvas) ?? [
      { offeringId: BIO, authority: "lms:nf-canvas", via: "lti-ags", services: canvas.contextServices(BIO_CONTEXT) },
      { offeringId: ENG9, authority: "local" },
    ],
  );
  const directory = options.directory ?? NORTHFIELD_LTI;
  const passback = new GradePassback({
    districtId: DistrictId.parse("dst_northfield"),
    directory: async () => directory,
    routes,
    approvals,
    ledger,
    sinks: options.sinks ?? [new LtiAgsGradeSink({ services, registrations: world.registrations })],
    now: world.clock.now,
  });
  return { ...world, canvas, fetched, services, nrps, ags, approvals, ledger, routes, passback };
}

/** A services world. */
export type ServicesWorld = Awaited<ReturnType<typeof createServicesWorld>>;

/** Morgan's approval of Amara's grade on `column`, approved `minutesAgo` before the world's now. */
export function approval(
  world: ServicesWorld,
  column: string,
  overrides: Partial<TeacherGradeApproval> & { minutesAgo?: number } = {},
): TeacherGradeApproval {
  const { minutesAgo = 5, ...rest } = overrides;
  return {
    offeringId: BIO,
    studentId: AMARA,
    column,
    gradeVersion: 1,
    scoreGiven: 8,
    scoreMaximum: 10,
    approverId: MORGAN,
    approvedAt: new Date(world.clock.now() - minutesAgo * 60_000).toISOString(),
    ...rest,
  };
}

/** The passback request matching an approval. */
export function requestFor(approved: TeacherGradeApproval, comment?: string) {
  return {
    offeringId: approved.offeringId,
    studentId: approved.studentId,
    column: approved.column,
    gradeVersion: approved.gradeVersion,
    scoreGiven: approved.scoreGiven,
    scoreMaximum: approved.scoreMaximum,
    ...(comment === undefined ? {} : { comment }),
  };
}
