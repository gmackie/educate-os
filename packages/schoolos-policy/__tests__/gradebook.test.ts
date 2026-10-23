import { describe, expect, it } from "vitest";
import { courseResource, engineFor, P, req } from "./setup.ts";

const BIO = "off_nf-bio-fall-p2"; // Morgan teaches; Amara, Dmitri and Elena enrolled
const BIO_SPRING = "off_nf-bio-spring-p4"; // completed term
const ENG9 = "off_nf-eng9-fall-p3"; // Rivera teaches, Chen co-teaches

const grid = (offeringId: string) => courseResource(offeringId, "gradebook", "teacher-only", { id: offeringId });
const row = (offeringId: string, owner: string) => courseResource(offeringId, "gradebook", "course", { id: offeringId, owner });

describe("gradebooks (SCHO-187)", () => {
  it("let the offering's teacher read, export and change the class grid directly", async () => {
    const { engine, audit } = engineFor();
    for (const action of ["read", "export", "update"] as const) {
      expect((await engine.decide(req(P.morgan, action, grid(BIO)))).decision.effect, action).toBe("allow");
    }
    expect(audit.events.at(-1)?.ruleId).toBe("course.teacher.gradebook");
    // Through an agent or tool, the teacher still reads but never changes it.
    expect((await engine.decide(req(P.morgan, "update", grid(BIO), "agent"))).decision.effect).toBe("deny");
  });

  it("let co-teachers and administrators over the offering read the grid, but not change it", async () => {
    const { engine } = engineFor();
    expect((await engine.decide(req(P.chen, "read", grid(ENG9)))).decision.effect).toBe("allow");
    expect((await engine.decide(req(P.chen, "update", grid(ENG9)))).decision.effect).toBe("deny");
    for (const admin of [P.nfAdmin, P.highPrincipal]) {
      expect((await engine.decide(req(admin, "read", grid(BIO)))).decision.effect).toBe("allow");
      expect((await engine.decide(req(admin, "update", grid(BIO)))).decision.effect).toBe("deny");
      expect((await engine.decide(req(admin, "export", grid(BIO)))).decision.effect).toBe("deny");
    }
  });

  it("refuse the grid to students, other offerings' teachers and other districts", async () => {
    const { engine } = engineFor();
    for (const who of [P.amara, P.rivera, P.rbHaddad, P.rbAdmin]) {
      expect((await engine.decide(req(who, "read", grid(BIO)))).decision.effect, who.principalId).toBe("deny");
    }
  });

  it("let a student read only their own row, even after leaving the class", async () => {
    const { engine } = engineFor();
    expect((await engine.decide(req(P.amara, "read", row(BIO, P.amara.principalId)))).decision.effect).toBe("allow");
    expect((await engine.decide(req(P.amara, "read", row(BIO, P.elena.principalId)))).decision.effect).toBe("deny");
    expect((await engine.decide(req(P.amara, "update", row(BIO, P.amara.principalId)))).decision.effect).toBe("deny");
    expect((await engine.decide(req(P.dmitri, "read", row(ENG9, P.dmitri.principalId)))).decision.effect).toBe("allow");
  });

  it("freeze once the term completes", async () => {
    const { engine } = engineFor();
    expect((await engine.decide(req(P.morgan, "update", grid(BIO_SPRING)))).decision).toMatchObject({ effect: "deny", reason: "term-not-active" });
    expect((await engine.decide(req(P.morgan, "read", grid(BIO_SPRING)))).decision.effect).toBe("allow");
  });
});
