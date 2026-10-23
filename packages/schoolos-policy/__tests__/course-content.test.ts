import { describe, expect, it } from "vitest";
import type { Action } from "@schoolos/contracts";
import { courseResource, engineFor, P, req } from "./setup.ts";

const BIO = "off_nf-bio-fall-p2"; // Morgan teaches; Amara, Dmitri and Elena enrolled
const BIO_SPRING = "off_nf-bio-spring-p4"; // completed term
const ENG9 = "off_nf-eng9-fall-p3"; // Rivera teaches; Dmitri dropped

const AUTHORING: Action[] = ["create", "update", "publish", "delete"];

describe("course content (SCHO-186)", () => {
  it("is authored by the offering's staff, drafts and published modules alike", async () => {
    const { engine, audit } = engineFor();
    for (const classification of ["teacher-only", "course"] as const) {
      for (const action of AUTHORING) {
        const { decision } = await engine.decide(req(P.morgan, action, courseResource(BIO, "course-content", classification)));
        expect(decision, `${action} ${classification}`).toMatchObject({ effect: "allow" });
      }
    }
    expect(audit.events.at(-1)?.ruleId).toBe("course.instructor.content");
  });

  it("refuses a teacher of another offering, a student, an administrator and another district's teacher", async () => {
    const { engine } = engineFor();
    const draft = courseResource(BIO, "course-content", "teacher-only");
    for (const who of [P.rivera, P.amara, P.nfAdmin, P.rbHaddad]) {
      for (const action of AUTHORING) {
        expect((await engine.decide(req(who, action, draft))).decision.effect, `${who.principalId} ${action}`).toBe("deny");
      }
    }
    expect((await engine.decide(req(P.rivera, "read", draft))).decision.effect).toBe("deny");
  });

  it("shows students published modules only, and only in classes they are actively enrolled in", async () => {
    const { engine } = engineFor();
    expect((await engine.decide(req(P.amara, "read", courseResource(BIO, "course-content", "course")))).decision.effect).toBe("allow");
    expect((await engine.decide(req(P.amara, "read", courseResource(BIO, "course-content", "teacher-only")))).decision.effect).toBe("deny");
    expect((await engine.decide(req(P.chidi, "read", courseResource(BIO, "course-content", "course")))).decision.effect).toBe("deny");
    expect((await engine.decide(req(P.dmitri, "read", courseResource(ENG9, "course-content", "course")))).decision.effect).toBe("deny");
    expect((await engine.decide(req(P.kai, "read", courseResource(BIO, "course-content", "course")))).decision.effect).toBe("deny");
  });

  it("lets administrators over the offering read drafts, and freezes content once the term completes", async () => {
    const { engine } = engineFor();
    expect((await engine.decide(req(P.nfAdmin, "read", courseResource(BIO, "course-content", "teacher-only")))).decision.effect).toBe("allow");
    const completed = courseResource(BIO_SPRING, "course-content", "course");
    expect((await engine.decide(req(P.morgan, "update", completed))).decision).toMatchObject({ effect: "deny", reason: "term-not-active" });
  });
});
