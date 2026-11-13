// SCHO-364: who may export the whole district (its records and its students' course work) in
// one archive. Only a district administrator, as a person; nobody else, and never through an agent.
import { describe, expect, it } from "vitest";
import { engineFor, P, req } from "./setup.ts";

const districtExport = (districtId = P.nfAdmin.districtId) => ({ resource: { kind: "district", scope: { level: "district", districtId }, classification: "restricted" } }) as const;

describe("district export (SCHO-364)", () => {
  it("lets a district admin export the district over HTTP", async () => {
    const { engine, audit } = engineFor();
    expect((await engine.decide(req(P.nfAdmin, "export", districtExport()))).decision.effect).toBe("allow");
    expect(audit.events.at(-1)?.ruleId).toBe("admin.district.export");
  });

  it("refuses school admins, teachers, students, agents and other districts' admins", async () => {
    const { engine } = engineFor();
    for (const who of [P.highPrincipal, P.morgan, P.rivera, P.amara, P.rbAdmin]) {
      expect((await engine.decide(req(who, "export", districtExport()))).decision.effect, who.principalId).toBe("deny");
    }
    expect((await engine.decide(req(P.nfAdmin, "export", districtExport(), "agent"))).decision.effect).toBe("deny");
    expect((await engine.decide(req(P.nfAdmin, "export", districtExport(P.rbAdmin.districtId)))).decision.effect).toBe("deny");
  });
});
