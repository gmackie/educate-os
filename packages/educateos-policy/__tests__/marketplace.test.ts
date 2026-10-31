// SCHO-209: who may install curriculum packs from the marketplace into a district.
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { engineFor, P, req } from "./setup.ts";

const pack = () => ({ resource: { kind: "marketplace-pack", scope: { level: "district", districtId: P.nfAdmin.districtId }, classification: "district-internal" } }) as const;

/** Northfield, with Patel also a curriculum admin for the district. */
const withCurriculumAdmin = {
  ...NORTHFIELD,
  roleAssignments: [
    ...NORTHFIELD.roleAssignments,
    { principalId: P.patel.principalId, role: "curriculum-admin", scope: { level: "district", districtId: P.nfAdmin.districtId }, source: "local-grant" },
  ],
} as typeof NORTHFIELD;

describe("marketplace packs (SCHO-209)", () => {
  it("let a district admin and a district curriculum admin list and install them", async () => {
    const { engine, audit } = engineFor(withCurriculumAdmin);
    for (const who of [P.nfAdmin, P.patel]) {
      for (const action of ["list", "read", "create"] as const) {
        expect((await engine.decide(req(who, action, pack()))).decision.effect, `${who.principalId} ${action}`).toBe("allow");
      }
    }
    expect(audit.events.at(-1)?.ruleId).toBe("curriculum.marketplace.install");
  });

  it("refuse teachers, students, school admins and other districts", async () => {
    const { engine } = engineFor();
    for (const who of [P.rivera, P.morgan, P.patel, P.amara, P.highPrincipal, P.rbAdmin]) {
      for (const action of ["list", "create"] as const) {
        expect((await engine.decide(req(who, action, pack()))).decision.effect, `${who.principalId} ${action}`).toBe("deny");
      }
    }
  });

  it("let nobody install one through an agent", async () => {
    const { engine } = engineFor();
    expect((await engine.decide(req(P.nfAdmin, "create", pack(), "agent"))).decision.effect).toBe("deny");
  });
});
