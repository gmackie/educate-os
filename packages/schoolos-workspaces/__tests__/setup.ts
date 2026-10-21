import { expect } from "vitest";
import {
  DistrictId,
  OfferingId,
  PrincipalId,
  TermId,
  type Caller,
  type DistrictDirectorySnapshot,
  type PolicySettings,
} from "@schoolos/contracts";
import { InMemoryAcademicStore } from "@schoolos/academics";
import { NORTHFIELD } from "@schoolos/fixtures";
import { directoryPolicyInformation, PolicyEngine, type PolicyAuditEvent, type PolicyAuditSink } from "@schoolos/policy";
import { InMemoryWorkspaceStore, WorkspaceDirectory } from "../src/index.ts";

/** Collects audit events in memory. */
export class MemoryAuditSink implements PolicyAuditSink {
  readonly events: PolicyAuditEvent[] = [];

  async record(event: PolicyAuditEvent): Promise<void> {
    this.events.push(event);
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

/** Retention used throughout: course workspaces are kept 30 days after close. */
export const RETENTION_DAYS = 30;

/** A workspace directory over a fresh copy of `snapshot`, with a settable clock. */
export function setup(snapshot: DistrictDirectorySnapshot = NORTHFIELD) {
  const academics = InMemoryAcademicStore.seeded(snapshot);
  const store = new InMemoryWorkspaceStore();
  const audit = new MemoryAuditSink();
  const clock = { now: new Date("2026-10-20T12:00:00Z") };
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(academics, { effectivePolicy: async () => FLOOR }),
    audit,
  });
  const workspaces = new WorkspaceDirectory({
    workspaces: store,
    directory: academics,
    policy: engine,
    retention: { courseWorkspaceRetentionDays: RETENTION_DAYS },
    now: () => clock.now,
  });

  /** Applies a change to the academic directory, as a roster sync or term transition would. */
  async function changeDirectory(change: (draft: DistrictDirectorySnapshot) => void) {
    const { snapshot: current, version } = await academics.load();
    change(current);
    await academics.commit(current, version);
  }

  return { workspaces, store, academics, audit, clock, changeDirectory };
}

/** An HTTP caller verified as `principalId`. */
export function as(principalId: string): Caller {
  const districtId = principalId.startsWith("prn_rb-") ? "dst_riverbend" : "dst_northfield";
  return { principal: { principalId: PrincipalId.parse(principalId), districtId: DistrictId.parse(districtId) }, channel: "http" };
}

/** Well-known callers. */
export const P = {
  nfAdmin: as("prn_nf-district-admin"),
  highPrincipal: as("prn_nf-principal-high"),
  morgan: as("prn_nf-morgan-lee"),
  rivera: as("prn_nf-teacher-rivera"),
  amara: as("prn_nf-student-amara"),
  chidi: as("prn_nf-student-chidi"),
  dmitri: as("prn_nf-student-dmitri"),
  elena: as("prn_nf-student-elena"),
  rbAdmin: as("prn_rb-district-admin"),
};

/** Well-known offerings and terms. */
export const O = {
  bioFall: OfferingId.parse("off_nf-bio-fall-p2"),
  bioSpring: OfferingId.parse("off_nf-bio-spring-p4"),
  eng9: OfferingId.parse("off_nf-eng9-fall-p3"),
};

/** Well-known terms. */
export const T = {
  fall: TermId.parse("trm_nf-2026-fall"),
  spring: TermId.parse("trm_nf-2026-spring"),
};

/** Sets an offering's term state in a draft directory. */
export function setTermState(draft: DistrictDirectorySnapshot, termId: TermId, state: DistrictDirectorySnapshot["terms"][number]["state"]) {
  draft.terms.find((t) => t.id === termId)!.state = state;
}

/** Expects a promise to reject with a SchoolOS error code. */
export async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}
