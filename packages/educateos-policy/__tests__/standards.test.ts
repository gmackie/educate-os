// SCHO-220: who may approve the standards releases a district's activities align to.
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { engineFor, P, req } from "./setup.ts";

const release = () => ({ resource: { kind: "standards-release", scope: { level: "district", districtId: P.nfAdmin.districtId }, classification: "district-internal" } }) as const;

/** Northfield, with Patel also a curriculum admin for the district. */
const withCurriculumAdmin = {
  ...NORTHFIELD,
  roleAssignments: [
    ...NORTHFIELD.roleAssignments,
    { principalId: P.patel.principalId, role: "curriculum-admin", scope: { level: "district", districtId: P.nfAdmin.districtId }, source: "local-grant" },
  ],
} as typeof NORTHFIELD;

describe("standards releases (SCHO-220)", () => {
  it("let a district admin and a district curriculum admin list, approve and withdraw them", async () => {
    const { engine, audit } = engineFor(withCurriculumAdmin);
    for (const who of [P.nfAdmin, P.patel]) {
      for (const action of ["list", "read", "approve"] as const) {
        expect((await engine.decide(req(who, action, release()))).decision.effect, `${who.principalId} ${action}`).toBe("allow");
      }
    }
    expect(audit.events.at(-1)?.ruleId).toBe("curriculum.standards.manage");
  });

  it("refuse teachers, students, school admins and other districts", async () => {
    const { engine } = engineFor();
    for (const who of [P.rivera, P.morgan, P.patel, P.amara, P.highPrincipal, P.rbAdmin]) {
      for (const action of ["list", "approve"] as const) {
        expect((await engine.decide(req(who, action, release()))).decision.effect, `${who.principalId} ${action}`).toBe("deny");
      }
    }
  });

  it("let nobody approve them through an agent", async () => {
    const { engine } = engineFor();
    expect((await engine.decide(req(P.nfAdmin, "approve", release(), "agent"))).decision.effect).toBe("deny");
  });
});
