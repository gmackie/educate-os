import { describe, expect, it } from "vitest";
import { GuardianRelationship, GUARDIAN_READABLE_KINDS, OfferingId, type Action, type DistrictDirectorySnapshot, type PrincipalId } from "@educateos/contracts";
import { InMemoryAcademicStore } from "@educateos/academics";
import { NORTHFIELD } from "@educateos/fixtures";
import {
  DEFAULT_POLICY_RULES,
  directoryPolicyInformation,
  guardianGuidanceRelationships,
  guardianRelationships,
  InMemoryGuardianGuidanceGrantStore,
  InMemoryGuardianRelationshipStore,
  InMemoryPolicyAuditSink,
  nextGuardianGuidanceGrant,
  PolicyEngine,
  WRITE_ACTIONS,
  type GuardianGuidanceCapability,
} from "../src/index.ts";
import { courseResource, P, req, SHARING_FLOOR, subject, withChanges } from "./setup.ts";

const BIO = "off_nf-bio-fall-p2";
const MATH7 = "off_nf-math7-fall-p1";
const G = { gina: subject("prn_nf-guardian-gina"), gus: subject("prn_nf-guardian-gus") };
const AMARA = "prn_nf-student-amara";
const ELENA = "prn_nf-student-elena";
const NOW = new Date("2026-10-23T12:00:00Z");
const now = () => NOW;

const WITH_GUARDIANS: DistrictDirectorySnapshot = withChanges(NORTHFIELD, (d) => {
  const issuer = d.district.trustedIssuers[0]!;
  for (const [id, name] of [[G.gina.principalId, "Gina Okafor"], [G.gus.principalId, "Gus Petrova"]] as const) {
    d.principals.push({ id, districtId: d.district.id, kind: "guardian", status: "active", displayName: name, externalIdentities: [{ districtId: d.district.id, issuer, subject: `guardian-${id}` }] });
  }
});

function relationship(id: string, guardian: PrincipalId, student: string, overrides: Partial<GuardianRelationship> = {}): GuardianRelationship {
  const admin = P.nfAdmin.principalId;
  return GuardianRelationship.parse({
    id, districtId: "dst_northfield", guardianPrincipalId: guardian, studentPrincipalId: student, status: "active",
    readableKinds: [...GUARDIAN_READABLE_KINDS], consent: "not-required", validFrom: "2026-08-01T00:00:00Z",
    created: { by: admin, at: "2026-08-01T00:00:00Z" }, confirmed: { by: admin, at: "2026-08-02T00:00:00Z" }, ...overrides,
  });
}
const recorded = (r: GuardianRelationship) => ({
  districtId: r.districtId, actor: { principalId: P.nfAdmin.principalId }, action: "guardian-relationship.recorded" as const,
  target: { relationshipId: r.id, guardianPrincipalId: r.guardianPrincipalId, studentPrincipalId: r.studentPrincipalId }, at: r.created.at,
});

const GINA_AMARA = relationship("grl_gina-amara", G.gina.principalId, AMARA);
const GUS_ELENA = relationship("grl_gus-elena", G.gus.principalId, ELENA);

async function setup(relationships: GuardianRelationship[] = [GINA_AMARA, GUS_ELENA], snapshot = WITH_GUARDIANS) {
  const store = new InMemoryGuardianRelationshipStore();
  for (const r of relationships) await store.commit(r, recorded(r), undefined);
  const grants = new InMemoryGuardianGuidanceGrantStore();
  const directory = InMemoryAcademicStore.seeded(snapshot);
  const audit = new InMemoryPolicyAuditSink();
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(directory, { effectivePolicy: async () => SHARING_FLOOR }, {
      relationships: [guardianRelationships(store, directory, now), guardianGuidanceRelationships(grants, store, directory, now)],
      now,
    }),
    audit,
    now,
  });
  const grant = async (r: GuardianRelationship, capabilities: GuardianGuidanceCapability[]) => {
    const current = await grants.get(r.id);
    await grants.save(nextGuardianGuidanceGrant(current, r, capabilities, P.nfAdmin.principalId, NOW), current?.revision ?? 0);
  };
  return { engine, audit, store, grants, grant };
}

const guidance = (offeringId: string, owner: string) => courseResource(offeringId, "learning-guidance", "course", { owner });
const ask = (who: ReturnType<typeof subject>, action: Action, target: ReturnType<typeof guidance>) => ({
  subject: who, action, resource: target.resource, context: { channel: "http" as const, termState: target.termState },
});

describe("guardian learning guidance is a separate, explicit opt-in", () => {
  it("is off by default for a confirmed relationship, for suggesting and for progress", async () => {
    const { engine } = await setup();
    for (const action of ["create", "read", "list"] as const) {
      expect(await engine.decide(ask(G.gina, action, guidance(BIO, AMARA)))).toMatchObject({
        decision: { effect: "deny" }, ruleId: "guard.guardian.child-records-only",
      });
    }
  });

  it("is off for a relationship established after the feature exists, until an administrator enables it", async () => {
    const { engine, store, grant } = await setup([GINA_AMARA]);
    const fresh = relationship("grl_gina-amara-2", G.gina.principalId, AMARA, { readableKinds: ["offering"] });
    await store.commit(relationship(GINA_AMARA.id, G.gina.principalId, AMARA, { status: "revoked", revoked: { by: P.nfAdmin.principalId, at: "2026-10-01T00:00:00Z" } }), recorded(GINA_AMARA), GINA_AMARA);
    await store.commit(fresh, recorded(fresh), undefined);
    expect((await engine.decide(ask(G.gina, "create", guidance(BIO, AMARA)))).decision.effect).toBe("deny");
    await grant(fresh, ["suggest"]);
    expect((await engine.decide(ask(G.gina, "create", guidance(BIO, AMARA)))).decision.effect).toBe("allow");
  });

  it("does not add the kind to what a relationship opens, and leaves its record untouched", async () => {
    const { store, grant } = await setup();
    expect(GUARDIAN_READABLE_KINDS).not.toContain("learning-guidance");
    const before = await store.get(GINA_AMARA.id);
    await grant(GINA_AMARA, ["suggest", "progress"]);
    expect(await store.get(GINA_AMARA.id)).toEqual(before);
    expect(before!.readableKinds).not.toContain("learning-guidance");
  });

  it("allows exactly the granted capability, audited under the relationship", async () => {
    const { engine, audit, grant } = await setup();
    await grant(GINA_AMARA, ["suggest"]);
    expect(await engine.decide(ask(G.gina, "create", guidance(BIO, AMARA)))).toMatchObject({
      decision: { effect: "allow" }, ruleId: "guardian.child.learning-guidance", grantId: GINA_AMARA.id,
    });
    expect((await engine.decide(ask(G.gina, "read", guidance(BIO, AMARA)))).decision.effect).toBe("deny");
    await grant(GINA_AMARA, ["progress"]);
    expect((await engine.decide(ask(G.gina, "read", guidance(BIO, AMARA)))).decision.effect).toBe("allow");
    expect((await engine.decide(ask(G.gina, "list", guidance(BIO, AMARA)))).decision.effect).toBe("allow");
    expect((await engine.decide(ask(G.gina, "create", guidance(BIO, AMARA)))).decision.effect).toBe("deny");
    expect(audit.events.some((e) => e.ruleId === "guardian.child.learning-guidance" && e.grantId === GINA_AMARA.id)).toBe(true);
  });

  it("never allows any other action on guidance, and never another kind through the grant", async () => {
    const { engine, grant } = await setup();
    await grant(GINA_AMARA, ["suggest", "progress"]);
    for (const action of WRITE_ACTIONS.filter((a) => a !== "create")) {
      expect((await engine.decide(ask(G.gina, action, guidance(BIO, AMARA)))).decision.effect).toBe("deny");
    }
    for (const kind of ["submission", "personal-conversation", "artifact", "gradebook", "quiz-attempt"] as const) {
      const target = courseResource(BIO, kind, "course", { owner: AMARA });
      expect((await engine.decide({ subject: G.gina, action: "read", resource: target.resource, context: { channel: "http", termState: target.termState } })).decision.effect).toBe("deny");
    }
  });

  it("stays on the child: another child, another family's guardian, or an unenrolled class is denied", async () => {
    const { engine, grant } = await setup();
    await grant(GINA_AMARA, ["suggest", "progress"]);
    await grant(GUS_ELENA, ["suggest", "progress"]);
    expect((await engine.decide(ask(G.gina, "create", guidance(BIO, ELENA)))).decision.effect).toBe("deny");
    expect((await engine.decide(ask(G.gus, "create", guidance(BIO, AMARA)))).decision.effect).toBe("deny");
    expect((await engine.decide(ask(G.gina, "create", guidance(MATH7, AMARA)))).decision.effect).toBe("deny");
    expect((await engine.decide(ask(G.gus, "create", guidance(BIO, ELENA)))).decision.effect).toBe("allow");
  });

  it("is limited to the offerings a relationship names, and needs the guardian to see the class", async () => {
    const narrowed = relationship(GINA_AMARA.id, G.gina.principalId, AMARA, { offeringIds: [OfferingId.parse("off_nf-eng9-fall-p3")] });
    const { engine, grant } = await setup([narrowed]);
    await grant(narrowed, ["suggest"]);
    expect((await engine.decide(ask(G.gina, "create", guidance(BIO, AMARA)))).decision.effect).toBe("deny");
    expect((await engine.decide(ask(G.gina, "create", guidance("off_nf-eng9-fall-p3", AMARA)))).decision.effect).toBe("allow");
    const hidden = relationship(GINA_AMARA.id, G.gina.principalId, AMARA, { readableKinds: ["official-grade"] });
    const second = await setup([hidden]);
    await second.grant(hidden, ["suggest"]);
    expect((await second.engine.decide(ask(G.gina, "create", guidance("off_nf-eng9-fall-p3", AMARA)))).decision.effect).toBe("deny");
  });

  it.each<[string, Partial<GuardianRelationship>]>([
    ["expired", { validUntil: "2026-10-01T00:00:00Z" }],
    ["pending", { status: "pending", confirmed: undefined }],
    ["revoked", { status: "revoked", revoked: { by: P.nfAdmin.principalId, at: "2026-10-20T00:00:00Z" } }],
    ["suspended", { suspended: { by: P.nfAdmin.principalId, at: "2026-10-20T00:00:00Z", reason: "custody-review" } }],
    ["without the student's consent", { consent: "withdrawn" }],
  ])("a grant is void while its relationship is %s", async (_label, overrides) => {
    const r = relationship(GINA_AMARA.id, G.gina.principalId, AMARA, overrides);
    const { engine, grant } = await setup([r]);
    await grant(r, ["suggest", "progress"]);
    expect((await engine.decide(ask(G.gina, "create", guidance(BIO, AMARA)))).decision.effect).toBe("deny");
    expect((await engine.decide(ask(G.gina, "read", guidance(BIO, AMARA)))).decision.effect).toBe("deny");
  });

  it("ends when an administrator revokes it, and keeps the history", async () => {
    const { engine, grants, grant } = await setup();
    await grant(GINA_AMARA, ["suggest"]);
    await grant(GINA_AMARA, []);
    expect((await engine.decide(ask(G.gina, "create", guidance(BIO, AMARA)))).decision.effect).toBe("deny");
    const stored = await grants.get(GINA_AMARA.id);
    expect(stored).toMatchObject({ enabled: false, capabilities: [], revision: 2 });
    expect(stored!.history.map((e) => e.action)).toEqual(["enabled", "revoked"]);
  });

  it("refuses a stale grant change instead of overwriting it", async () => {
    const { grants } = await setup();
    const first = nextGuardianGuidanceGrant(undefined, GINA_AMARA, ["suggest"], P.nfAdmin.principalId, NOW);
    await grants.save(first, 0);
    await expect(grants.save(first, 0)).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps guardian guidance and administrative disposition in exact, separate rules", () => {
    expect(DEFAULT_POLICY_RULES.filter((r) => r.when.kinds?.includes("learning-guidance")).map(({ id, when, effect }) => ({ id, when, effect }))).toEqual([
      {
        id: "guardian.child.learning-guidance",
        when: { principalKinds: ["guardian"], kinds: ["learning-guidance"], ownership: ["others"], relationships: ["guardian-of"], classifications: ["course"], actions: ["create", "read", "list"] },
        effect: { effect: "allow" },
      },
      {
        id: "admin.student-learning.lifecycle",
        when: { kinds: ["learning-guidance"], roles: ["district-admin"], classifications: ["restricted"], actions: ["read", "configure", "delete"], channels: ["http"] },
        effect: { effect: "allow" },
      },
    ]);
  });

  it("allows guardian suggestions and progress without allowing deletion or staff access to that guidance", async () => {
    const { engine, grant } = await setup();
    await grant(GINA_AMARA, ["suggest", "progress"]);
    for (const action of ["create", "read", "list"] as const) {
      expect(await engine.decide(ask(G.gina, action, guidance(BIO, AMARA)))).toMatchObject({
        decision: { effect: "allow" }, ruleId: "guardian.child.learning-guidance", grantId: GINA_AMARA.id,
      });
      for (const who of [P.nfAdmin, P.highPrincipal, P.morgan, P.rivera, P.amara, P.dmitri, P.rbAdmin]) {
        expect((await engine.decide(ask(who, action, guidance(BIO, AMARA)))).decision.effect, `${who.principalId}: ${action}`).toBe("deny");
      }
    }
    expect((await engine.decide(ask(G.gina, "delete", guidance(BIO, AMARA)))).decision.effect).toBe("deny");
    expect((await engine.decide(ask(P.nfAdmin, "delete", guidance(BIO, AMARA)))).decision.effect).toBe("deny");
  });

  it("allows restricted lifecycle operations only for the district administrator over HTTP", async () => {
    const { engine, audit, grant } = await setup();
    await grant(GINA_AMARA, ["suggest", "progress"]);
    // The lifecycle API addresses one student at district scope, separately from course guidance.
    const target = { resource: { kind: "learning-guidance", id: AMARA, ownerPrincipalId: P.amara.principalId, scope: { level: "district", districtId: P.nfAdmin.districtId }, classification: "restricted" } } as const;
    for (const action of ["read", "configure", "delete"] as const) {
      expect(await engine.decide(req(P.nfAdmin, action, target))).toMatchObject({ decision: { effect: "allow" }, ruleId: "admin.student-learning.lifecycle" });
      expect(audit.events.at(-1)).toMatchObject({ principalId: P.nfAdmin.principalId, resourceId: AMARA, action, effect: "allow", ruleId: "admin.student-learning.lifecycle" });
      for (const who of [G.gina, G.gus, P.highPrincipal, P.morgan, P.rivera, P.amara, P.dmitri, P.rbAdmin, subject("prn_unknown"), subject(P.nfAdmin.principalId, "dst_riverbend")]) {
        expect((await engine.decide(req(who, action, target))).decision.effect, `${who.principalId} in ${who.districtId}: ${action}`).toBe("deny");
      }
      for (const channel of ["agent", "mcp", "lti-service"] as const) {
        expect((await engine.decide(req(P.nfAdmin, action, target, channel))).decision.effect, `${channel}: ${action}`).toBe("deny");
      }
      const foreign = { resource: { ...target.resource, scope: { level: "district", districtId: P.rbAdmin.districtId } } } as const;
      expect((await engine.decide(req(P.nfAdmin, action, foreign))).decision.effect).toBe("deny");
    }
    for (const action of ["create", "list", "update", "export"] as const) {
      expect((await engine.decide(req(P.nfAdmin, action, target))).decision.effect, action).toBe("deny");
    }
  });
});
