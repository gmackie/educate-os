import { describe, expect, it } from "vitest";
import type { Action, AuthorizationRequest } from "@schoolos/contracts";
import type { PolicyEngine } from "../src/index.ts";
import { courseResource, engineFor, P, req } from "./setup.ts";

const BIO = "off_nf-bio-fall-p2"; // Morgan teaches; Amara, Dmitri, Elena enrolled
const BIO_SPRING = "off_nf-bio-spring-p4"; // completed term
const ENG9 = "off_nf-eng9-fall-p3"; // Rivera teaches, Chen co-teaches; Dmitri dropped

async function decide(engine: PolicyEngine, request: AuthorizationRequest) {
  const { decision, ruleId } = await engine.decide(request);
  return { ...decision, ruleId };
}

const bioBaseline = courseResource(BIO, "artifact", "course", { id: "art_bio-starter" });
const eng9Baseline = courseResource(ENG9, "artifact", "course", { id: "art_eng9-starter" });

describe("SCHO-81: class baselines", () => {
  const { engine } = engineFor();

  it.each<Action>(["create", "publish"])("lets an offering's teacher and co-teacher %s an unowned course baseline", async (action) => {
    expect(await decide(engine, req(P.morgan, action, bioBaseline))).toEqual({ effect: "allow", ruleId: "course.instructor.baseline" });
    expect(await decide(engine, req(P.chen, action, eng9Baseline))).toEqual({ effect: "allow", ruleId: "course.instructor.baseline" });
  });

  it("does not let a teacher publish a baseline to an offering they do not teach", async () => {
    expect(await decide(engine, req(P.rivera, "publish", bioBaseline))).toMatchObject({ effect: "deny" });
    expect(await decide(engine, req(P.patel, "create", bioBaseline))).toMatchObject({ effect: "deny" });
  });

  it("does not let staff edit or delete a published baseline, or classify one as anything but course", async () => {
    for (const action of ["update", "delete", "share"] as const) {
      expect(await decide(engine, req(P.morgan, action, bioBaseline))).toMatchObject({ effect: "deny" });
    }
    const teacherOnly = courseResource(BIO, "artifact", "teacher-only", { id: "art_bio-key" });
    expect(await decide(engine, req(P.morgan, "publish", teacherOnly))).toMatchObject({ effect: "deny" });
  });

  it("lets actively enrolled students read and list a baseline", async () => {
    for (const action of ["read", "list"] as const) {
      expect(await decide(engine, req(P.amara, action, bioBaseline))).toEqual({ effect: "allow", ruleId: "course.student.baseline-read" });
    }
  });

  it("keeps baselines from students who are not, or no longer, enrolled", async () => {
    expect(await decide(engine, req(P.chidi, "read", bioBaseline))).toMatchObject({ effect: "deny" });
    // Dmitri's English 9 enrollment is inactive.
    expect(await decide(engine, req(P.dmitri, "read", eng9Baseline))).toMatchObject({ effect: "deny" });
  });

  it("never lets a student create, publish or change a baseline", async () => {
    for (const action of ["create", "publish", "update", "delete"] as const) {
      expect(await decide(engine, req(P.amara, action, bioBaseline))).toMatchObject({ effect: "deny" });
    }
  });

  it("does not reach another student's work or teacher-only material", async () => {
    const elenaWork = courseResource(BIO, "artifact", "course", { id: "art_elena", owner: "prn_nf-student-elena" });
    expect(await decide(engine, req(P.amara, "read", elenaWork))).toMatchObject({ effect: "deny" });
    const answerKey = courseResource(BIO, "artifact", "teacher-only", { id: "art_bio-key" });
    expect(await decide(engine, req(P.amara, "read", answerKey))).toMatchObject({ effect: "deny" });
  });

  it("keeps a completed term's baselines readable but closed to new ones", async () => {
    const spring = courseResource(BIO_SPRING, "artifact", "course", { id: "art_spring-starter" });
    expect(await decide(engine, req(P.morgan, "publish", spring))).toEqual({ effect: "deny", reason: "term-not-active", ruleId: "guard.term-completed.read-only" });
    expect(await decide(engine, req(P.amara, "read", spring))).toEqual({ effect: "allow", ruleId: "course.student.baseline-read" });
  });

  it("gives administrators nothing new", async () => {
    expect(await decide(engine, req(P.nfAdmin, "publish", bioBaseline))).toMatchObject({ effect: "deny" });
    expect(await decide(engine, req(P.nfAdmin, "read", bioBaseline))).toMatchObject({ effect: "deny" });
  });
});
