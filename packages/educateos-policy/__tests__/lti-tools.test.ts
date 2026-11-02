// SCHO-179: a registered LTI tool as a subject of the engine. Its facts come from a subject source,
// never from the directory, and carry no role; its only authority is the `lti-deployment`
// relationship, on the `lti-service` channel, to list one offering's enrollments.
import { describe, expect, it } from "vitest";
import { InMemoryAcademicStore } from "@educateos/academics";
import { DistrictId, PrincipalId, type ResourceRef } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { directoryPolicyInformation, InMemoryPolicyAuditSink, PolicyEngine, type RelationshipSource, type SubjectSource } from "../src/index.ts";
import { P, SHARING_FLOOR } from "./setup.ts";

const NF = DistrictId.parse("dst_northfield");
const TOOL = PrincipalId.parse("prn_lti-tool-0102");
const BIO = { level: "offering", districtId: NF, schoolId: "sch_nf-high", offeringId: "off_nf-bio-fall-p2" } as const;

/** An engine whose one extra subject is `TOOL`, deployed to Biology with the roster service while `deployed`. */
function toolEngine(state: { deployed: boolean; active: boolean }) {
  const asked: string[] = [];
  const subjects: SubjectSource = {
    async subjectFacts(principalId) {
      asked.push(principalId);
      if (principalId !== TOOL && principalId !== P.morgan.principalId) return undefined;
      // A source that claims a role, or a directory principal, is not believed.
      return { principalId, districtId: NF, kind: "service", active: state.active, roles: [{ principalId, role: "district-admin", scope: { level: "district", districtId: NF }, source: "local-grant" }] };
    },
  };
  const relationships: RelationshipSource = {
    async relationships(subject, resource: ResourceRef) {
      const enrollments = resource.kind === "enrollment" && resource.scope.level === "offering" && resource.scope.offeringId === BIO.offeringId;
      return subject === TOOL && state.deployed && enrollments ? [{ relationship: "lti-deployment", grantId: "ltd_deployment" }] : [];
    },
  };
  const information = directoryPolicyInformation(InMemoryAcademicStore.seeded(NORTHFIELD), { effectivePolicy: async () => SHARING_FLOOR }, { subjects: [subjects], relationships: [relationships] });
  return { engine: new PolicyEngine({ information, audit: new InMemoryPolicyAuditSink() }), asked };
}

const roster = (subject = { principalId: TOOL, districtId: NF }, channel = "lti-service", scope: object = BIO) => ({
  subject,
  action: "list",
  resource: { kind: "enrollment", scope, classification: "course" },
  context: { channel },
});

describe("an LTI tool as a policy subject (SCHO-179)", () => {
  it("lists an offering's enrollments through its deployment, audited with it", async () => {
    const { engine } = toolEngine({ deployed: true, active: true });
    expect(await engine.decide(roster())).toMatchObject({ decision: { effect: "allow" }, ruleId: "lti.tool.roster", grantId: "ltd_deployment" });
  });

  it("gets nothing without the deployment, while revoked, off the channel, or through a role it claimed", async () => {
    expect((await toolEngine({ deployed: false, active: true }).engine.decide(roster())).ruleId).toBe("guard.lti-service.tool-rules-only");
    expect((await toolEngine({ deployed: true, active: false }).engine.decide(roster())).decision.effect).toBe("deny");
    const { engine: e } = toolEngine({ deployed: true, active: true });
    expect((await e.decide(roster(undefined, "http"))).decision.effect).toBe("deny");
    expect((await e.decide(roster(undefined, "lti-service", { ...BIO, offeringId: "off_nf-eng9-fall-p3" }))).decision.effect).toBe("deny");
    // The district-admin role the source claimed is dropped: no directory read for the tool.
    expect((await e.decide({ ...roster(), action: "read", resource: { kind: "district", id: NF, scope: { level: "district", districtId: NF }, classification: "district-internal" }, context: { channel: "http" } })).decision.effect).toBe("deny");
  });

  it("never asks a subject source about a directory principal", async () => {
    const { engine: e, asked } = toolEngine({ deployed: true, active: true });
    expect((await e.decide(roster(P.morgan))).ruleId).toBe("guard.lti-service.tool-rules-only");
    expect(asked).not.toContain(P.morgan.principalId);
  });
});
