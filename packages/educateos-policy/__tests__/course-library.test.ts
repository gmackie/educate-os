// SCHO-331: who may list the district's course library and import signed course bundles into it.
// Installing a library course into a class needs no rule of its own: it is the class's teacher
// creating activities and content, which the existing teaching rules decide step by step.
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { engineFor, P, req } from "./setup.ts";

const coursePackage = () => ({ resource: { kind: "course-package", scope: { level: "district", districtId: P.nfAdmin.districtId }, classification: "district-internal" } }) as const;

/** Northfield, with Patel also a curriculum admin for the district. */
const withCurriculumAdmin = {
  ...NORTHFIELD,
  roleAssignments: [
    ...NORTHFIELD.roleAssignments,
    { principalId: P.patel.principalId, role: "curriculum-admin", scope: { level: "district", districtId: P.nfAdmin.districtId }, source: "local-grant" },
  ],
} as typeof NORTHFIELD;

describe("course library (SCHO-331)", () => {
  it("lets a district admin and a district curriculum admin list it and import a bundle", async () => {
    const { engine, audit } = engineFor(withCurriculumAdmin);
    for (const who of [P.nfAdmin, P.patel]) {
      for (const action of ["list", "read", "create"] as const) {
        expect((await engine.decide(req(who, action, coursePackage()))).decision.effect, `${who.principalId} ${action}`).toBe("allow");
      }
    }
    expect(audit.events.at(-1)?.ruleId).toBe("curriculum.course-library.import");
  });

  it("refuses teachers, students, school admins and other districts", async () => {
    const { engine } = engineFor();
    for (const who of [P.rivera, P.morgan, P.patel, P.amara, P.highPrincipal, P.rbAdmin]) {
      for (const action of ["list", "create"] as const) {
        expect((await engine.decide(req(who, action, coursePackage()))).decision.effect, `${who.principalId} ${action}`).toBe("deny");
      }
    }
  });

  it("lets nobody change a library version once imported, or import one through an agent", async () => {
    const { engine } = engineFor();
    for (const action of ["update", "delete"] as const) {
      expect((await engine.decide(req(P.nfAdmin, action, coursePackage()))).decision.effect, action).toBe("deny");
    }
    expect((await engine.decide(req(P.nfAdmin, "create", coursePackage(), "agent"))).decision.effect).toBe("deny");
  });
});
