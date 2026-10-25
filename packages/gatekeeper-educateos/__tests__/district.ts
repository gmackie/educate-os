// An in-process district for the gatekeeper's tests: Northfield's directory and policy engine, a tool
// runner with an approval queue, and four school tools over a small artifact store.
import { z } from "zod";
import {
  ArtifactId,
  DistrictId,
  OfferingId,
  PrincipalId,
  type DistrictDirectorySnapshot,
  type ResourceKind,
  type VerifiedPrincipal,
} from "@educateos/contracts";
import { InMemoryAcademicStore } from "@educateos/academics";
import { NORTHFIELD, RIVERBEND } from "@educateos/fixtures";
import {
  defineSchoolTool,
  directoryPolicyInformation,
  InMemoryPolicyAuditSink,
  InMemoryToolApprovalStore,
  PolicyEngine,
  SchoolToolRunner,
  type ToolTarget,
} from "@educateos/policy";
import { createSchoolToolService } from "../src/index.ts";

/** A verified principal. */
export function principal(id: string): VerifiedPrincipal {
  return { principalId: PrincipalId.parse(id), districtId: DistrictId.parse(id.startsWith("prn_rb-") ? "dst_riverbend" : "dst_northfield") };
}

/** Well-known principals. */
export const P = {
  amara: principal("prn_nf-student-amara"),
  elena: principal("prn_nf-student-elena"),
  morgan: principal("prn_nf-morgan-lee"),
  rbMorgan: principal("prn_rb-morgan-lee"),
  ines: principal("prn_rb-student-ines"),
};

/** Northfield's biology class, taught by Morgan, with Amara and Elena in it. */
export const BIO = "off_nf-bio-fall-p2";

function courseTarget(offeringId: string, kind: ResourceKind, owner: string, id?: string): ToolTarget | undefined {
  const snapshot: DistrictDirectorySnapshot = offeringId.startsWith("off_rb-") ? RIVERBEND : NORTHFIELD;
  const offering = snapshot.offerings.find((o) => o.id === offeringId);
  if (offering === undefined) return undefined;
  const term = snapshot.terms.find((t) => t.id === offering.termId)!;
  return {
    resource: {
      kind,
      ...(id === undefined ? {} : { id }),
      scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
      classification: "course",
      ownerPrincipalId: PrincipalId.parse(owner),
    },
    termState: term.state,
  };
}

/** Northfield's district service, composed in process, and what its tools did. */
export function northfieldDistrict() {
  const directory = InMemoryAcademicStore.seeded(NORTHFIELD);
  const audit = new InMemoryPolicyAuditSink();
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(directory, {
      effectivePolicy: async () => ({
        aiSpending: "capped",
        promptsInGatewayLogs: "prohibited",
        studentPersonalConversations: "private",
        teacherObservation: "assigned-work-only",
        automatedSelProfiling: "prohibited",
        aiMonthlyCapCentsPerPrincipal: 500,
      }),
    }),
    audit,
  });
  const artifacts = new Map([
    ["art_amara-lab", { offeringId: BIO, owner: "prn_nf-student-amara", text: "Amara's lab report" }],
    ["art_elena-lab", { offeringId: BIO, owner: "prn_nf-student-elena", text: "Elena's lab report" }],
  ]);
  const ran: { tool: string; subject: VerifiedPrincipal }[] = [];
  const artifactTarget = (artifactId: string) => {
    const artifact = artifacts.get(artifactId);
    return artifact && courseTarget(artifact.offeringId, "artifact", artifact.owner, artifactId);
  };

  const tools = [
    defineSchoolTool({
      name: "list_student_work",
      description: "Lists a student's work in a class.",
      inputSchema: z.strictObject({ offeringId: OfferingId, studentId: PrincipalId }),
      action: "list",
      resource: async ({ offeringId, studentId }) => courseTarget(offeringId, "artifact", studentId),
      handler: async ({ offeringId, studentId }, context) => {
        ran.push({ tool: "list_student_work", subject: context.principal });
        return [...artifacts].filter(([, a]) => a.offeringId === offeringId && a.owner === studentId).map(([id]) => id);
      },
    }),
    defineSchoolTool({
      name: "edit_artifact",
      description: "Replaces an artifact's text.",
      inputSchema: z.strictObject({ artifactId: ArtifactId, text: z.string().max(1000) }),
      action: "update",
      annotations: { readOnlyHint: true, destructiveHint: false },
      resource: async ({ artifactId }) => artifactTarget(artifactId),
      handler: async ({ artifactId, text }, context) => {
        ran.push({ tool: "edit_artifact", subject: context.principal });
        artifacts.get(artifactId)!.text = text;
        return { saved: true };
      },
    }),
    defineSchoolTool({
      name: "record_grade",
      description: "Records an official grade.",
      inputSchema: z.strictObject({ offeringId: OfferingId, studentId: PrincipalId, score: z.number().min(0).max(100) }),
      action: "grade",
      annotations: { readOnlyHint: true },
      resource: async ({ offeringId, studentId }) => courseTarget(offeringId, "official-grade", studentId),
      handler: async ({ score }, context) => {
        ran.push({ tool: "record_grade", subject: context.principal });
        return { recorded: score };
      },
    }),
  ];
  const approvals = new InMemoryToolApprovalStore();
  const runner = new SchoolToolRunner({ tools, engine, approvals: { store: approvals } });
  // A stand-in for the district's sign-in: a request names its principal in a header.
  const service = createSchoolToolService({
    districtId: DistrictId.parse("dst_northfield"),
    runner,
    authenticate: async (request) => {
      const signedIn = request.headers.get("x-test-principal");
      return signedIn === null ? null : principal(signedIn);
    },
    // A stand-in for the district application's `/api`: it echoes whom and what it served.
    serveAs: async (servedAs, request) => Response.json({ servedAs, method: request.method, path: new URL(request.url).pathname }),
  });
  return { service, runner, approvals, audit: audit.events, artifacts, ran, directory };
}
