import { describe, expect, it } from "vitest";
import {
  checkDirectoryIntegrity,
  DistrictId,
  GuardianRelationship,
  PrincipalId,
  type Action,
  type DistrictDirectorySnapshot,
  type ResourceKind,
} from "@schoolos/contracts";
import { InMemoryAcademicStore } from "@schoolos/academics";
import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import {
  directoryPolicyInformation,
  guardianRelationships,
  InMemoryGuardianRelationshipStore,
  InMemoryPolicyAuditSink,
  PolicyEngine,
  subjectFactsFrom,
  WRITE_ACTIONS,
} from "../src/index.ts";
import { courseResource, P, personalResource, req, SHARING_FLOOR, subject, withChanges } from "./setup.ts";

const BIO = "off_nf-bio-fall-p2"; // Amara, Dmitri and Elena enrolled
const BIO_SPRING = "off_nf-bio-spring-p4"; // completed term; Amara
const ENG9 = "off_nf-eng9-fall-p3"; // Amara and Elena enrolled; Dmitri dropped
const MATH7 = "off_nf-math7-fall-p1"; // Chidi

/** Amara's guardian, and Elena's (a different family). */
const G = { gina: subject("prn_nf-guardian-gina"), gus: subject("prn_nf-guardian-gus") };

/** Northfield with two guardian principals, signed in through the district's own IdP. */
const WITH_GUARDIANS = withChanges(NORTHFIELD, (d) => {
  const issuer = d.district.trustedIssuers[0]!;
  for (const [id, name] of [[G.gina.principalId, "Gina Okafor"], [G.gus.principalId, "Gus Petrova"]] as const) {
    d.principals.push({
      id,
      districtId: d.district.id,
      kind: "guardian",
      status: "active",
      displayName: name,
      externalIdentities: [{ districtId: d.district.id, issuer, subject: `guardian-${id}` }],
    });
  }
});

const NOW = new Date("2026-10-23T12:00:00Z");
const now = () => NOW;

/** A confirmed, in-force relationship, with `overrides` applied. */
function relationship(id: string, guardian: PrincipalId, student: string, overrides: Partial<GuardianRelationship> = {}): GuardianRelationship {
  const admin = P.nfAdmin.principalId;
  return GuardianRelationship.parse({
    id,
    districtId: "dst_northfield",
    guardianPrincipalId: guardian,
    studentPrincipalId: student,
    status: "active",
    readableKinds: ["offering", "activity", "feedback", "official-grade", "announcement"],
    consent: "not-required",
    validFrom: "2026-08-01T00:00:00Z",
    created: { by: admin, at: "2026-08-01T00:00:00Z" },
    confirmed: { by: admin, at: "2026-08-02T00:00:00Z" },
    ...overrides,
  });
}

/** The audit event of recording `r`, as a district admin. */
function recordedEvent(r: GuardianRelationship) {
  return {
    districtId: r.districtId,
    actor: { principalId: P.nfAdmin.principalId },
    action: "guardian-relationship.recorded" as const,
    target: { relationshipId: r.id, guardianPrincipalId: r.guardianPrincipalId, studentPrincipalId: r.studentPrincipalId },
    at: r.created.at,
  };
}

const GINA_AMARA = relationship("grl_gina-amara", G.gina.principalId, "prn_nf-student-amara");
const GUS_ELENA = relationship("grl_gus-elena", G.gus.principalId, "prn_nf-student-elena");

/** An engine whose information point reads the given guardian relationships, at {@link NOW}. */
async function guardians(relationships: GuardianRelationship[] = [GINA_AMARA, GUS_ELENA], snapshot: DistrictDirectorySnapshot = WITH_GUARDIANS) {
  const store = new InMemoryGuardianRelationshipStore();
  for (const r of relationships) await store.commit(r, recordedEvent(r), undefined);
  const directory = InMemoryAcademicStore.seeded(snapshot);
  const audit = new InMemoryPolicyAuditSink();
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(directory, { effectivePolicy: async () => SHARING_FLOOR }, {
      relationships: [guardianRelationships(store, directory, now)],
      now,
    }),
    audit,
    now,
  });
  return { engine, audit, store };
}

const amaraGrade = courseResource(BIO, "official-grade", "course", { id: "grd_amara-bio", owner: "prn_nf-student-amara" });
const amaraFeedback = courseResource(BIO, "feedback", "course", { id: "sub_amara-cells", owner: "prn_nf-student-amara" });
const elenaGrade = courseResource(BIO, "official-grade", "course", { id: "grd_elena-bio", owner: "prn_nf-student-elena" });
const bioOffering = courseResource(BIO, "offering", "course", { id: BIO });
const bioAssignment = courseResource(BIO, "activity", "course", { id: "act_bio-cells" });
const bioAnnouncement = courseResource(BIO, "announcement", "course", { id: "ann_bio-field-trip" });

describe("guardian access (ADR-0012)", () => {
  it("reads the child's offerings, assignments, feedback, grades and announcements, audited with the relationship", async () => {
    const { engine, audit } = await guardians();
    for (const target of [bioOffering, bioAssignment, amaraFeedback, amaraGrade, bioAnnouncement]) {
      expect(await engine.decide(req(G.gina, "read", target))).toMatchObject({
        decision: { effect: "allow" },
        ruleId: "guardian.child.read",
        grantId: GINA_AMARA.id,
      });
    }
    // Listing the child's grades in an offering names the child as owner, and needs no record ID.
    const { resource, termState } = courseResource(BIO, "official-grade", "course", { owner: "prn_nf-student-amara" });
    expect((await engine.decide(req(G.gina, "list", { resource, termState }))).decision.effect).toBe("allow");
    expect(audit.events.filter((e) => e.ruleId === "guardian.child.read").every((e) => e.grantId === GINA_AMARA.id)).toBe(true);
  });

  it("keeps siblings apart: a guardian of one child reads nothing of another", async () => {
    const { engine } = await guardians();
    expect(await engine.decide(req(G.gina, "read", elenaGrade))).toMatchObject({
      decision: { effect: "deny", reason: "no-matching-grant" },
      ruleId: "guard.guardian.child-records-only",
    });
    expect(await engine.decide(req(G.gina, "read", courseResource(MATH7, "offering", "course", { id: MATH7 }))))
      .toMatchObject({ decision: { effect: "deny" } });
  });

  it("keeps guardians of different children apart", async () => {
    const { engine } = await guardians();
    expect((await engine.decide(req(G.gus, "read", elenaGrade))).decision.effect).toBe("allow");
    expect((await engine.decide(req(G.gus, "read", amaraGrade))).decision.effect).toBe("deny");
    expect((await engine.decide(req(G.gina, "read", elenaGrade))).decision.effect).toBe("deny");
    // Both children are in Biology, so both guardians see the class's own material, each through their own record.
    expect(await engine.decide(req(G.gus, "read", bioAnnouncement))).toMatchObject({ decision: { effect: "allow" }, grantId: GUS_ELENA.id });
  });

  it.each<[string, Partial<GuardianRelationship>]>([
    ["expired", { validUntil: "2026-10-01T00:00:00Z" }],
    ["not yet valid", { validFrom: "2026-11-01T00:00:00Z" }],
    ["pending confirmation", { status: "pending", confirmed: undefined }],
    ["revoked", { status: "revoked", revoked: { by: P.nfAdmin.principalId, at: "2026-10-20T00:00:00Z" } }],
    ["suspended", { suspended: { by: P.nfAdmin.principalId, at: "2026-10-20T00:00:00Z", reason: "custody-review" } }],
    ["refused the student's consent", { consent: "withdrawn" }],
  ])("denies through a relationship that is %s", async (_label, overrides) => {
    const { engine } = await guardians([relationship(GINA_AMARA.id, G.gina.principalId, "prn_nf-student-amara", overrides)]);
    for (const target of [amaraGrade, bioOffering]) {
      expect(await engine.decide(req(G.gina, "read", target))).toMatchObject({
        decision: { effect: "deny" },
        ruleId: "guard.guardian.child-records-only",
      });
    }
  });

  it.each<Action>([...WRITE_ACTIONS, "export", "invoke-tool"])("denies %s, even on the child's own records", async (action) => {
    const { engine } = await guardians();
    for (const target of [amaraGrade, amaraFeedback, bioAssignment, bioAnnouncement]) {
      expect((await engine.decide(req(G.gina, action, target))).decision.effect).toBe("deny");
    }
  });

  it("never reaches the child's personal space, conversations, working artifacts or submissions", async () => {
    const { engine } = await guardians();
    const amara = "prn_nf-student-amara";
    const targets = [
      personalResource("personal-workspace", amara, { id: "wsp_amara" }),
      personalResource("personal-conversation", amara, { id: "chat-amara-1" }),
      personalResource("artifact", amara, { id: "art_amara-journal" }),
      courseResource(BIO, "shared-conversation", "course", { id: "chat-amara-shared", owner: amara }),
      courseResource(BIO, "artifact", "course", { id: "art_amara-bio", owner: amara }),
      courseResource(BIO, "submission", "course", { id: "sub_amara-cells", owner: amara }),
      courseResource(BIO, "course-workspace", "course", { id: "wsp_amara-bio", owner: amara }),
      courseResource(BIO, "enrollment", "course", { id: "enr_nf-02", owner: amara }),
    ];
    for (const target of targets) {
      expect(await engine.decide(req(G.gina, "read", target))).toMatchObject({ decision: { effect: "deny" }, ruleId: "guard.guardian.child-records-only" });
    }
  });

  it("never reads teacher-only material, rosters, the directory or district reference data", async () => {
    const { engine } = await guardians();
    const district = { resource: { kind: "district" as const, scope: { level: "district" as const, districtId: DistrictId.parse("dst_northfield") }, classification: "district-internal" as const } };
    const targets = [
      courseResource(BIO, "activity", "teacher-only", { id: "act_bio-cells" }),
      courseResource(BIO, "feedback", "teacher-only", { id: "sub_amara-cells", owner: "prn_nf-student-amara" }),
      courseResource(BIO, "enrollment", "course"),
      { resource: { ...district.resource, kind: "term" as const } },
      { resource: { ...district.resource, kind: "principal" as const } },
    ];
    for (const target of targets) {
      for (const action of ["read", "list"] as const) {
        expect((await engine.decide(req(G.gina, action, target))).decision.effect).toBe("deny");
      }
    }
    expect((await engine.decide(req(G.gina, "invoke-tool", district))).decision.effect).toBe("deny");
  });

  it("denies across districts, whatever the relationship records say", async () => {
    const { engine } = await guardians([GINA_AMARA, relationship("grl_gina-ines", G.gina.principalId, "prn_rb-student-ines", { districtId: DistrictId.parse("dst_riverbend") })]);
    const inesOffering = RIVERBEND.enrollments.find((e) => e.principalId === "prn_rb-student-ines")!.offeringId;
    const inesGrade = courseResource(inesOffering, "official-grade", "course", { id: "grd_ines", owner: "prn_rb-student-ines", snapshot: RIVERBEND });
    expect(await engine.decide(req(G.gina, "read", inesGrade))).toMatchObject({ decision: { effect: "deny", reason: "cross-district" } });
    // Claiming to be a Riverbend principal is refused too: no such guardian is in Riverbend's directory.
    expect((await engine.decide(req(subject(G.gina.principalId, "dst_riverbend"), "read", inesGrade))).decision.effect).toBe("deny");
  });

  it("honours the offerings and kinds a relationship is narrowed to", async () => {
    const { engine } = await guardians([
      relationship(GINA_AMARA.id, G.gina.principalId, "prn_nf-student-amara", { offeringIds: [ENG9 as never], readableKinds: ["offering", "official-grade"] }),
    ]);
    expect((await engine.decide(req(G.gina, "read", amaraGrade))).decision.effect).toBe("deny");
    const eng9Grade = courseResource(ENG9, "official-grade", "course", { id: "grd_amara-eng9", owner: "prn_nf-student-amara" });
    expect((await engine.decide(req(G.gina, "read", eng9Grade))).decision.effect).toBe("allow");
    expect((await engine.decide(req(G.gina, "read", courseResource(ENG9, "announcement", "course", { id: "ann_eng9" })))).decision.effect).toBe("deny");
  });

  it("follows the child's enrollments for class material, and the child's ownership for their records", async () => {
    const dmitri = relationship("grl_gina-dmitri", G.gina.principalId, "prn_nf-student-dmitri");
    const { engine } = await guardians([dmitri]);
    // Dmitri dropped English 9: its class material is closed to his guardian, his grade there is not.
    expect((await engine.decide(req(G.gina, "read", courseResource(ENG9, "announcement", "course", { id: "ann_eng9" })))).decision.effect).toBe("deny");
    expect((await engine.decide(req(G.gina, "read", courseResource(ENG9, "official-grade", "course", { id: "grd_dmitri-eng9", owner: "prn_nf-student-dmitri" }))))).toMatchObject({ decision: { effect: "allow" } });
    // A completed term stays readable.
    const amara = await guardians();
    expect((await amara.engine.decide(req(G.gina, "read", courseResource(BIO_SPRING, "official-grade", "course", { id: "grd_amara-spring", owner: "prn_nf-student-amara" }))))).toMatchObject({ decision: { effect: "allow" } });
  });

  it("ends with the guardian's or the child's status", async () => {
    for (const [who, status] of [[G.gina.principalId, "inactive"], ["prn_nf-student-amara", "graduated"]] as const) {
      const snapshot = withChanges(WITH_GUARDIANS, (d) => {
        d.principals.find((p) => p.id === who)!.status = status;
      });
      const { engine } = await guardians([GINA_AMARA], snapshot);
      expect((await engine.decide(req(G.gina, "read", amaraGrade))).decision.effect).toBe("deny");
    }
  });

  it("ignores any role a guardian is given: authority is the relationship alone", async () => {
    // The directory refuses to store one...
    const snapshot = withChanges(WITH_GUARDIANS, (d) => {
      d.roleAssignments.push({ principalId: G.gina.principalId, role: "district-admin", scope: { level: "district", districtId: d.district.id }, source: "local-grant" });
    });
    expect(checkDirectoryIntegrity(snapshot)).toContainEqual(expect.objectContaining({ path: `roleAssignments[${snapshot.roleAssignments.length - 1}].role` }));
    expect(subjectFactsFrom(snapshot, G.gina.principalId)).toMatchObject({ kind: "guardian", roles: [] });
    // ...and the rule table denies a guardian anything past their relationships even if facts carry one.
    const information = directoryPolicyInformation(InMemoryAcademicStore.seeded(WITH_GUARDIANS), { effectivePolicy: async () => SHARING_FLOOR });
    const engine = new PolicyEngine({
      information: {
        ...information,
        subjectFacts: async (id) => ({ ...(await information.subjectFacts(id))!, roles: snapshot.roleAssignments.filter((a) => a.principalId === id) }),
      },
      audit: new InMemoryPolicyAuditSink(),
    });
    expect(await engine.decide(req(G.gina, "read", elenaGrade))).toMatchObject({ decision: { effect: "deny" }, ruleId: "guard.guardian.child-records-only" });
    expect(await engine.decide(req(G.gina, "update", courseResource(BIO, "offering", "course", { id: BIO })))).toMatchObject({ decision: { effect: "deny" } });
  });

  it("lets only a district admin manage guardian relationships", async () => {
    const { engine } = await guardians();
    const record = { resource: { kind: "guardian-relationship" as ResourceKind, id: GINA_AMARA.id, scope: { level: "district" as const, districtId: DistrictId.parse("dst_northfield") }, classification: "restricted" as const } };
    for (const action of ["create", "approve", "update"] as const) {
      expect(await engine.decide(req(P.nfAdmin, action, record))).toMatchObject({ decision: { effect: "allow" }, ruleId: "admin.district.guardian-relationships" });
      expect((await engine.decide(req(P.highPrincipal, action, record))).decision.effect).toBe("deny");
      expect((await engine.decide(req(G.gina, action, record))).decision.effect).toBe("deny");
    }
    expect((await engine.decide(req(G.gina, "read", record))).decision.effect).toBe("deny");
  });
});

describe("announcements", () => {
  it("are posted by the offering's instructors and read by its students and administrators", async () => {
    const { engine } = await guardians();
    const draft = courseResource(BIO, "announcement", "course");
    expect((await engine.decide(req(P.morgan, "create", draft))).decision.effect).toBe("allow");
    expect((await engine.decide(req(P.amara, "create", draft))).decision.effect).toBe("deny");
    expect((await engine.decide(req(P.amara, "read", bioAnnouncement))).decision.effect).toBe("allow");
    expect((await engine.decide(req(P.chidi, "read", bioAnnouncement))).decision.effect).toBe("deny");
    expect((await engine.decide(req(P.highPrincipal, "read", bioAnnouncement))).decision.effect).toBe("allow");
  });
});

/** Northfield with the district admin's grant dated, and an engine judging it at `at`. */
function datedAdmin(dates: { validFrom?: string; validUntil?: string }, at: Date) {
  const snapshot = withChanges(NORTHFIELD, (d) => {
    Object.assign(d.roleAssignments.find((a) => a.role === "district-admin")!, dates);
  });
  const clock = () => at;
  return new PolicyEngine({
    information: directoryPolicyInformation(InMemoryAcademicStore.seeded(snapshot), { effectivePolicy: async () => SHARING_FLOOR }, { now: clock }),
    audit: new InMemoryPolicyAuditSink(),
    now: clock,
  });
}

describe("dated role assignments (ADR-0012)", () => {
  const school = { resource: { kind: "school" as const, id: "sch_nf-high", scope: { level: "school" as const, districtId: DistrictId.parse("dst_northfield"), schoolId: "sch_nf-high" as never }, classification: "district-internal" as const } };

  it("holds from validFrom up to, not including, validUntil", async () => {
    const dates = { validFrom: "2026-10-01T00:00:00Z", validUntil: "2026-10-15T00:00:00Z" };
    for (const [at, effect] of [
      ["2026-09-30T23:59:59Z", "deny"],
      ["2026-10-01T00:00:00Z", "allow"],
      ["2026-10-14T23:59:59Z", "allow"],
      ["2026-10-15T00:00:00Z", "deny"],
    ] as const) {
      expect((await datedAdmin(dates, new Date(at)).decide(req(P.nfAdmin, "update", school))).decision.effect, at).toBe(effect);
    }
  });

  it("is enforced by the engine itself, whatever facts the information point returns", async () => {
    const engine = new PolicyEngine({
      information: {
        subjectFacts: async (principalId) => ({
          principalId,
          districtId: DistrictId.parse("dst_northfield"),
          kind: "staff",
          active: true,
          roles: [{ principalId, role: "district-admin", scope: { level: "district", districtId: DistrictId.parse("dst_northfield") }, source: "local-grant", validUntil: "2026-10-01T00:00:00Z" }],
        }),
        effectivePolicy: async () => SHARING_FLOOR,
        scopeExists: async () => true,
        relationships: async () => [],
      },
      audit: new InMemoryPolicyAuditSink(),
      now: () => NOW,
    });
    expect(await engine.decide(req(P.nfAdmin, "update", school))).toMatchObject({ decision: { effect: "deny" }, ruleId: "default.deny" });
  });

  it("refuses inverted dates in the directory", () => {
    const snapshot = withChanges(NORTHFIELD, (d) => {
      Object.assign(d.roleAssignments[0]!, { validFrom: "2026-10-15T00:00:00Z", validUntil: "2026-10-01T00:00:00Z" });
    });
    expect(checkDirectoryIntegrity(snapshot)).toContainEqual(expect.objectContaining({ path: "roleAssignments[0].validUntil" }));
  });
});

describe("guardian principals in the directory", () => {
  it("cannot enroll", () => {
    const snapshot = withChanges(WITH_GUARDIANS, (d) => {
      d.enrollments.push({ id: "enr_nf-guardian" as never, districtId: d.district.id, offeringId: BIO as never, principalId: G.gina.principalId, role: "student", status: "active" });
    });
    expect(checkDirectoryIntegrity(snapshot)).toContainEqual(expect.objectContaining({ path: `enrollments[${snapshot.enrollments.length - 1}].principalId` }));
    expect(checkDirectoryIntegrity(WITH_GUARDIANS)).toEqual([]);
  });

  it("parse only as consistent relationship records", () => {
    const base = { ...GINA_AMARA };
    expect(GuardianRelationship.safeParse({ ...base, status: "active", confirmed: undefined }).success).toBe(false);
    expect(GuardianRelationship.safeParse({ ...base, status: "revoked" }).success).toBe(false);
    expect(GuardianRelationship.safeParse({ ...base, validUntil: base.validFrom }).success).toBe(false);
    expect(GuardianRelationship.safeParse({ ...base, studentPrincipalId: base.guardianPrincipalId }).success).toBe(false);
    expect(GuardianRelationship.safeParse({ ...base, readableKinds: ["submission"] }).success).toBe(false);
    expect(GuardianRelationship.safeParse({ ...base, id: "agr_not-a-guardian-id" }).success).toBe(false);
    expect(GuardianRelationship.safeParse({ ...base, suspended: { by: P.nfAdmin.principalId, at: base.validFrom, reason: "Court order re: Mr. Okafor" } }).success).toBe(false);
  });
});
