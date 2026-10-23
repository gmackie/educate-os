// Course discussions (SCHO-190): who reads, writes and moderates an offering's topics and posts.
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

const topic = (offeringId: string, classification: Classification = "course") => courseResource(offeringId, "discussion-topic", classification, { id: "dtp_1" });
const post = (offeringId: string, owner: string, classification: Classification = "course") =>
  courseResource(offeringId, "discussion-post", classification, { id: "dps_1", owner });

async function effect(who: Parameters<typeof req>[0], action: Action, target: ReturnType<typeof post>, engine = engineFor().engine) {
  return (await engine.decide(req(who, action, target))).decision.effect;
}

describe("discussions (SCHO-190)", () => {
  it("lets enrolled students read topics and visible posts, and write, edit, delete and report", async () => {
    const { engine, audit } = engineFor();
    expect(await effect(P.amara, "read", topic(BIO), engine)).toBe("allow");
    expect(await effect(P.amara, "list", post(BIO, ELENA), engine)).toBe("allow");
    for (const action of ["create", "update", "delete"] as const) {
      expect(await effect(P.amara, action, post(BIO, AMARA), engine), action).toBe("allow");
    }
    expect(audit.events.at(-1)?.ruleId).toBe("discussion.student.own-posts");
    expect(await effect(P.amara, "submit", post(BIO, ELENA), engine)).toBe("allow");
    expect(audit.events.at(-1)?.ruleId).toBe("discussion.student.report");
  });

  it("shows a waiting post to its author and staff only, and a hidden or removed post to staff only", async () => {
    const { engine } = engineFor();
    expect(await effect(P.amara, "read", post(BIO, AMARA, "teacher-only"), engine)).toBe("allow");
    expect(await effect(P.elena, "read", post(BIO, AMARA, "teacher-only"), engine)).toBe("deny");
    expect(await effect(P.morgan, "read", post(BIO, AMARA, "teacher-only"), engine)).toBe("allow");
    expect(await effect(P.amara, "read", post(BIO, AMARA, "restricted"), engine)).toBe("deny");
    expect(await effect(P.elena, "read", post(BIO, AMARA, "restricted"), engine)).toBe("deny");
    expect(await effect(P.morgan, "read", post(BIO, AMARA, "restricted"), engine)).toBe("allow");
    expect(await effect(P.amara, "read", topic(BIO, "teacher-only"), engine)).toBe("deny");
  });

  it("lets the offering's staff manage topics and moderate every post", async () => {
    const { engine, audit } = engineFor();
    for (const action of ["create", "update", "delete", "configure"] as const) {
      expect(await effect(P.morgan, action, topic(BIO), engine), action).toBe("allow");
    }
    for (const classification of ["course", "teacher-only", "restricted"] as const) {
      expect(await effect(P.morgan, "review", post(BIO, AMARA, classification), engine), classification).toBe("allow");
    }
    expect(audit.events.at(-1)?.ruleId).toBe("discussion.instructor.moderate");
    expect(await effect(P.morgan, "create", post(BIO, P.morgan.principalId), engine)).toBe("allow");
  });

  it("lets administrators over the offering read topics and visible posts only", async () => {
    const { engine } = engineFor();
    expect(await effect(P.nfAdmin, "read", topic(BIO), engine)).toBe("allow");
    expect(await effect(P.nfAdmin, "read", post(BIO, AMARA), engine)).toBe("allow");
    expect(await effect(P.nfAdmin, "read", post(BIO, AMARA, "teacher-only"), engine)).toBe("deny");
    expect(await effect(P.nfAdmin, "read", post(BIO, AMARA, "restricted"), engine)).toBe("deny");
    expect(await effect(P.nfAdmin, "review", post(BIO, AMARA), engine)).toBe("deny");
    expect(await effect(P.nfAdmin, "create", topic(BIO), engine)).toBe("deny");
  });

  it("denies the unenrolled, other offerings, other districts, students moderating and editing others' posts", async () => {
    const { engine } = engineFor();
    // Chidi is not in Biology; Dmitri dropped English 9; Kai is another district's student.
    expect(await effect(P.chidi, "read", topic(BIO), engine)).toBe("deny");
    expect(await effect(P.chidi, "create", post(BIO, P.chidi.principalId), engine)).toBe("deny");
    expect(await effect(P.dmitri, "read", post(ENG9, AMARA), engine)).toBe("deny");
    expect(await effect(P.dmitri, "create", post(ENG9, P.dmitri.principalId), engine)).toBe("deny");
    expect(await effect(P.kai, "read", post(BIO, AMARA), engine)).toBe("deny");
    expect(await effect(P.rbHaddad, "review", post(BIO, AMARA), engine)).toBe("deny");
    // Rivera teaches English 9, not Biology.
    expect(await effect(P.rivera, "read", post(BIO, AMARA), engine)).toBe("deny");
    expect(await effect(P.rivera, "review", post(BIO, AMARA), engine)).toBe("deny");
    expect(await effect(P.rivera, "create", topic(BIO), engine)).toBe("deny");
    // A student never moderates, edits or deletes another's post, nor manages a topic.
    for (const action of ["review", "update", "delete"] as const) {
      expect(await effect(P.elena, action, post(BIO, AMARA), engine), action).toBe("deny");
    }
    for (const action of ["create", "update", "delete", "configure"] as const) {
      expect(await effect(P.amara, action, topic(BIO), engine), action).toBe("deny");
    }
    // Nobody reports their own post; nobody writes a post as someone else.
    expect(await effect(P.amara, "submit", post(BIO, AMARA), engine)).toBe("deny");
    expect(await effect(P.morgan, "update", post(BIO, AMARA), engine)).toBe("deny");
  });

  it("freezes a completed term's discussions", async () => {
    const { engine } = engineFor();
    expect((await engine.decide(req(P.amara, "create", post(BIO_SPRING, AMARA)))).decision).toMatchObject({ effect: "deny", reason: "term-not-active" });
    expect((await engine.decide(req(P.morgan, "review", post(BIO_SPRING, AMARA)))).decision).toMatchObject({ effect: "deny", reason: "term-not-active" });
  });

  it("gives a guardian nothing, even with a confirmed relationship to an enrolled child", async () => {
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
    await relationships.put(GuardianRelationship.parse({
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
    }));
    const now = () => new Date("2026-10-23T12:00:00Z");
    const directory = InMemoryAcademicStore.seeded(snapshot);
    const audit = new InMemoryPolicyAuditSink();
    const engine = new PolicyEngine({
      information: directoryPolicyInformation(directory, { effectivePolicy: async () => SHARING_FLOOR }, { relationships: [guardianRelationships(relationships, directory, now)], now }),
      audit,
      now,
    });
    for (const target of [topic(BIO), post(BIO, AMARA), post(BIO, ELENA)]) {
      for (const action of ["read", "list", "create", "submit"] as const) {
        expect(await effect(gina, action, target, engine), action).toBe("deny");
        expect(audit.events.at(-1)?.ruleId).toBe("guard.guardian.child-records-only");
      }
    }
  });
});
