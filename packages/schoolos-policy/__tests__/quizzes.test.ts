// Quizzes (SCHO-191): who builds, takes, reads and grades an offering's quizzes and attempts.
import { describe, expect, it } from "vitest";
import { GuardianRelationship, type Action, type Classification } from "@schoolos/contracts";
import { InMemoryAcademicStore } from "@schoolos/academics";
import { NORTHFIELD } from "@schoolos/fixtures";
import { directoryPolicyInformation, guardianRelationships, InMemoryGuardianRelationshipStore, InMemoryPolicyAuditSink, PolicyEngine } from "../src/index.ts";
import { courseResource, engineFor, P, req, SHARING_FLOOR, subject, withChanges } from "./setup.ts";

const BIO = "off_nf-bio-fall-p2"; // Morgan teaches; Amara, Dmitri and Elena enrolled
const BIO_SPRING = "off_nf-bio-spring-p4"; // completed term
const ENG9 = "off_nf-eng9-fall-p3"; // Rivera teaches; Dmitri dropped
const AMARA = "prn_nf-student-amara";
const ELENA = "prn_nf-student-elena";
const DMITRI = "prn_nf-student-dmitri";

const quiz = (offeringId: string, classification: Classification = "course") => courseResource(offeringId, "quiz", classification, { id: "qz_1" });
const attempt = (offeringId: string, owner: string) => courseResource(offeringId, "quiz-attempt", "course", { id: "qza_1", owner });

async function effect(who: Parameters<typeof req>[0], action: Action, target: ReturnType<typeof attempt>, engine = engineFor().engine) {
  return (await engine.decide(req(who, action, target))).decision.effect;
}

describe("quizzes (SCHO-191)", () => {
  it("lets enrolled students read published quizzes and start, save and submit their own attempts", async () => {
    const { engine, audit } = engineFor();
    expect(await effect(P.amara, "read", quiz(BIO), engine)).toBe("allow");
    expect(audit.events.at(-1)?.ruleId).toBe("quiz.student.read");
    for (const action of ["create", "update", "submit"] as const) {
      expect(await effect(P.amara, action, attempt(BIO, AMARA), engine), action).toBe("allow");
    }
    expect(audit.events.at(-1)?.ruleId).toBe("quiz.student.own-attempts");
    expect(await effect(P.amara, "read", attempt(BIO, AMARA), engine)).toBe("allow");
  });

  it("never shows a student a quiz's teacher-only definition, or another student's attempt", async () => {
    const { engine } = engineFor();
    expect(await effect(P.amara, "read", quiz(BIO, "teacher-only"), engine)).toBe("deny");
    for (const action of ["read", "update", "submit", "review"] as const) {
      expect(await effect(P.elena, action, attempt(BIO, AMARA), engine), action).toBe("deny");
    }
    // Nobody starts an attempt as someone else, staff included.
    expect(await effect(P.morgan, "create", attempt(BIO, AMARA), engine)).toBe("deny");
    expect(await effect(P.morgan, "submit", attempt(BIO, AMARA), engine)).toBe("deny");
    // Students never manage or release a quiz.
    for (const action of ["create", "update", "delete", "publish", "grade"] as const) {
      expect(await effect(P.amara, action, quiz(BIO), engine), action).toBe("deny");
    }
  });

  it("lets the offering's staff build, publish and release quizzes, and read and grade every attempt", async () => {
    const { engine, audit } = engineFor();
    for (const classification of ["course", "teacher-only"] as const) {
      expect(await effect(P.morgan, "read", quiz(BIO, classification), engine), classification).toBe("allow");
      for (const action of ["create", "update", "delete", "publish", "grade"] as const) {
        expect(await effect(P.morgan, action, quiz(BIO, classification), engine), action).toBe("allow");
      }
    }
    expect(audit.events.at(-1)?.ruleId).toBe("quiz.instructor.manage");
    expect(await effect(P.morgan, "read", attempt(BIO, AMARA), engine)).toBe("allow");
    expect(await effect(P.morgan, "review", attempt(BIO, AMARA), engine)).toBe("allow");
    expect(audit.events.at(-1)?.ruleId).toBe("quiz.instructor.grade-attempts");
  });

  it("lets administrators read quizzes for oversight, but never students' attempts", async () => {
    const { engine, audit } = engineFor();
    expect(await effect(P.nfAdmin, "read", quiz(BIO, "teacher-only"), engine)).toBe("allow");
    expect(audit.events.at(-1)?.ruleId).toBe("admin.quiz-oversight");
    expect(await effect(P.nfAdmin, "read", attempt(BIO, AMARA), engine)).toBe("deny");
    expect(await effect(P.nfAdmin, "update", quiz(BIO), engine)).toBe("deny");
    expect(await effect(P.nfAdmin, "grade", quiz(BIO), engine)).toBe("deny");
  });

  it("denies other offerings, other districts and the unenrolled; a dropped student keeps reading their own attempts", async () => {
    const { engine } = engineFor();
    // Chidi is not in Biology; Kai is another district's student; Rivera teaches English 9, not Biology.
    expect(await effect(P.chidi, "read", quiz(BIO), engine)).toBe("deny");
    expect(await effect(P.chidi, "create", attempt(BIO, P.chidi.principalId), engine)).toBe("deny");
    expect(await effect(P.kai, "read", quiz(BIO), engine)).toBe("deny");
    expect(await effect(P.rbHaddad, "read", attempt(BIO, AMARA), engine)).toBe("deny");
    expect(await effect(P.rivera, "read", attempt(BIO, AMARA), engine)).toBe("deny");
    expect(await effect(P.rivera, "grade", quiz(BIO), engine)).toBe("deny");
    // Dmitri dropped English 9: no new attempts, no quiz, but his own attempts stay readable.
    expect(await effect(P.dmitri, "read", quiz(ENG9), engine)).toBe("deny");
    expect(await effect(P.dmitri, "create", attempt(ENG9, DMITRI), engine)).toBe("deny");
    expect(await effect(P.dmitri, "read", attempt(ENG9, DMITRI), engine)).toBe("allow");
  });

  it("freezes a completed term's quizzes and attempts", async () => {
    const { engine } = engineFor();
    expect((await engine.decide(req(P.amara, "submit", attempt(BIO_SPRING, AMARA)))).decision).toMatchObject({ effect: "deny", reason: "term-not-active" });
    expect((await engine.decide(req(P.morgan, "grade", quiz(BIO_SPRING)))).decision).toMatchObject({ effect: "deny", reason: "term-not-active" });
  });

  it("gives a guardian nothing of a quiz, even with a confirmed relationship to an enrolled child", async () => {
    const gina = subject("prn_nf-guardian-gina");
    const snapshot = withChanges(NORTHFIELD, (d) => {
      d.principals.push({
        id: gina.principalId,
        districtId: d.district.id,
        kind: "guardian",
        status: "active",
        displayName: "Gina Okafor",
        externalIdentities: [{ districtId: d.district.id, issuer: d.district.trustedIssuers[0]!, subject: "guardian-gina" }],
      });
    });
    const relationships = new InMemoryGuardianRelationshipStore();
    const relationship = GuardianRelationship.parse({
      id: "grl_gina-amara",
      districtId: "dst_northfield",
      guardianPrincipalId: gina.principalId,
      studentPrincipalId: AMARA,
      status: "active",
      readableKinds: ["offering", "activity", "feedback", "official-grade", "announcement"],
      consent: "not-required",
      validFrom: "2026-08-01T00:00:00Z",
      created: { by: P.nfAdmin.principalId, at: "2026-08-01T00:00:00Z" },
      confirmed: { by: P.nfAdmin.principalId, at: "2026-08-02T00:00:00Z" },
    });
    const target = { relationshipId: relationship.id, guardianPrincipalId: relationship.guardianPrincipalId, studentPrincipalId: relationship.studentPrincipalId };
    await relationships.commit(relationship, { districtId: relationship.districtId, actor: { principalId: P.nfAdmin.principalId }, action: "guardian-relationship.recorded", target, at: "2026-08-01T00:00:00Z" }, undefined);
    const now = () => new Date("2026-10-23T12:00:00Z");
    const directory = InMemoryAcademicStore.seeded(snapshot);
    const audit = new InMemoryPolicyAuditSink();
    const engine = new PolicyEngine({
      information: directoryPolicyInformation(directory, { effectivePolicy: async () => SHARING_FLOOR }, { relationships: [guardianRelationships(relationships, directory, now)], now }),
      audit,
      now,
    });
    for (const target of [quiz(BIO), quiz(BIO, "teacher-only"), attempt(BIO, AMARA), attempt(BIO, ELENA)]) {
      for (const action of ["read", "list", "create", "submit"] as const) {
        expect(await effect(gina, action, target, engine), action).toBe("deny");
        expect(audit.events.at(-1)?.ruleId).toBe("guard.guardian.child-records-only");
      }
    }
    // The released score is the official grade the guardian already reads (ADR-0012).
    expect(await effect(gina, "read", courseResource(BIO, "official-grade", "course", { id: "asg_quiz", owner: AMARA }), engine)).toBe("allow");
  });
});
