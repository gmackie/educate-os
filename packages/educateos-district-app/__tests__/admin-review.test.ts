// SCHO-376: what an IT reviewer reads in the admin console. A district administrator, as a person,
// searches the decision trail (the safety decision log and the admin audit log), reads Hall
// Monitor's discussion screening across the district, and reads how the district signs people in.
// Nobody else does, and none of it carries content or a secret.
import { describe, expect, it } from "vitest";
import type { DiscussionScreening } from "@educateos/discussions";
import { bootDistrict, expectError, NF, NORTHFIELD, northfieldConfig } from "./support.ts";

/** A stand-in for Hall Monitor: `[[block]]`, `[[hold]]` and `[[coach]]` pick that decision. */
const fakeHallMonitor = (): DiscussionScreening => ({
  settings: { tenantId: "tenant-nf", profileId: "student-9-12", revision: "rev-1", costCenterId: "cc-safety" },
  hallMonitor: {
    async evaluate(request) {
      const text = request.content.type === "text" ? request.content.text : "";
      const decision = (["block", "hold", "coach"] as const).find((d) => text.includes(`[[${d}]]`)) ?? "allow";
      return { decision, reasonCodes: decision === "allow" ? [] : [`moderation.${decision}`] };
    },
  },
});

describe("the safety decision log", () => {
  it("lists the district's decisions newest first, filtered by outcome, rule, person and kind, a page at a time", async () => {
    const district = await bootDistrict();
    const admin = district.tokenFor(NF.admin);
    // A refusal: a school administrator reaching for the district's classes. (A student reaching
    // for the console is turned away by its surface before any policy decision.)
    expectError(await district.call(district.tokenFor(NF.morgan), "admin.listOfferings"), 403, "forbidden");
    await district.ok(district.tokenFor(NF.amara), "me.get");

    const refused = await district.ok(admin, "admin.decisionLog", { query: { outcome: "refused" } });
    expect(refused.entries[0]).toMatchObject({ principalId: NF.morgan, principalName: "Morgan Lee", effect: "deny", reason: expect.any(String) });
    expect(refused.entries.every((e) => e.effect === "deny")).toBe(true);
    // Newest first, each at its place in the trail.
    expect(refused.entries.map((e) => e.seq)).toStrictEqual(refused.entries.map((e) => e.seq).toSorted((a, b) => b - a));

    const morgans = await district.ok(admin, "admin.decisionLog", { query: { principalId: NF.morgan } });
    expect(morgans.entries.length).toBeGreaterThan(0);
    expect(morgans.entries.every((e) => e.principalId === NF.morgan)).toBe(true);
    const byRule = await district.ok(admin, "admin.decisionLog", { query: { rule: "admin.district.audit-log" } });
    // The administrator's own searches are decisions too, recorded like any other.
    expect(byRule.entries.length).toBeGreaterThanOrEqual(3);
    expect(byRule.entries.every((e) => e.ruleId === "admin.district.audit-log" && e.principalId === NF.admin)).toBe(true);
    const byKind = await district.ok(admin, "admin.decisionLog", { query: { resourceKind: "audit-event", outcome: "allowed" } });
    expect(byKind.entries.every((e) => e.resourceKind === "audit-event" && e.effect === "allow")).toBe(true);

    // Enough decisions for more than one page, then page back through them without repeats.
    for (let i = 0; i < 60; i++) await district.ok(admin, "admin.health");
    const first = await district.ok(admin, "admin.decisionLog", {});
    expect(first.entries).toHaveLength(50);
    expect(first.nextBefore).toBeDefined();
    const second = await district.ok(admin, "admin.decisionLog", { query: { before: first.nextBefore! } });
    expect(Math.max(...second.entries.map((e) => e.seq))).toBeLessThan(Math.min(...first.entries.map((e) => e.seq)));
    // Never content: no bodies, prompts or messages, only identifiers and closed vocabulary.
    expect(Object.keys(first.entries[0]!).every((key) => ["seq", "decidedAt", "correlationId", "principalId", "principalName", "action", "resourceKind", "resourceId", "channel", "effect", "reason", "ruleId", "grantId", "delegationId"].includes(key))).toBe(true);
  });

  it("answers district administrators only", async () => {
    const district = await bootDistrict();
    for (const who of [NF.rivera, NF.amara, NF.morgan]) {
      expectError(await district.call(district.tokenFor(who), "admin.decisionLog"), 403, "forbidden");
      expectError(await district.call(district.tokenFor(who), "admin.auditLog"), 403, "forbidden");
      expectError(await district.call(district.tokenFor(who), "admin.screeningLog"), 403, "forbidden");
      expectError(await district.call(district.tokenFor(who), "admin.signInSettings"), 403, "forbidden");
    }
    expect(district.audit.events().at(-1)).toMatchObject({ effect: "deny", ruleId: "admin.district.sign-in.others" });
  });
});

describe("the admin audit log", () => {
  it("lists the changes administrators were allowed to make, and nothing they only read", async () => {
    const district = await bootDistrict();
    const admin = district.tokenFor(NF.admin);
    await district.ok(admin, "admin.applyConfig", { body: { document: northfieldConfig(), acknowledgeApprovals: true } });
    await district.ok(admin, "admin.renameDistrict", { body: { name: "Northfield Unified" } });
    await district.ok(admin, "admin.health");
    // A teacher's own change is not an administrator's.
    await district.ok(district.tokenFor(NF.rivera), "teacher.createTopic", { params: { offeringId: NF.eng9 }, body: { title: "Debate", prompt: "Go." } });

    const log = await district.ok(admin, "admin.auditLog");
    expect(log.entries.length).toBeGreaterThanOrEqual(2);
    expect(log.entries.every((e) => e.effect === "allow" && e.ruleId.startsWith("admin.") && e.action !== "read" && e.action !== "list")).toBe(true);
    expect(log.entries[0]).toMatchObject({ principalId: NF.admin, principalName: "Avery Admin", action: "update", resourceKind: "district" });
    expect(log.entries.some((e) => e.action === "configure" && e.resourceKind === "capability-config")).toBe(true);
    expect(log.entries.some((e) => e.principalId === NF.rivera)).toBe(false);

    const renames = await district.ok(admin, "admin.auditLog", { query: { resourceKind: "district" } });
    expect(renames.entries.map((e) => e.resourceKind)).toContain("district");
    expect(renames.entries.every((e) => e.resourceKind === "district")).toBe(true);
  });
});

describe("Hall Monitor's screening log", () => {
  it("lists the posts Hall Monitor refused, held and flagged across the district's classes, never their text", async () => {
    const district = await bootDistrict(undefined, { discussionScreening: fakeHallMonitor() });
    const rivera = district.tokenFor(NF.rivera);
    const amara = district.tokenFor(NF.amara);
    const topic = await district.ok(rivera, "teacher.createTopic", { params: { offeringId: NF.eng9 }, body: { title: "Debate", prompt: "Go." } });
    const at = { params: { offeringId: NF.eng9, topicId: topic.id } };
    expectError(await district.call(amara, "student.createPost", { ...at, body: { body: "Mean words [[block]]" } }), 403, "policy-violation");
    await district.ok(amara, "student.createPost", { ...at, body: { body: "Worrying [[hold]]" } });
    await district.ok(amara, "student.createPost", { ...at, body: { body: "Borderline [[coach]]" } });
    await district.ok(amara, "student.createPost", { ...at, body: { body: "Fine." } });

    const log = await district.ok(district.tokenFor(NF.admin), "admin.screeningLog");
    expect(log.screening).toBe("hall-monitor");
    expect(log.truncated).toBe(false);
    expect(log.entries.map((e) => [e.decision, e.reasonCodes, e.authorName, e.postStatus])).toEqual(expect.arrayContaining([
      ["refused", ["moderation.block"], "Amara Okafor", undefined],
      ["hold", ["moderation.hold"], "Amara Okafor", "pending"],
      ["coach", ["moderation.coach"], "Amara Okafor", "visible"],
    ]));
    expect(log.entries).toHaveLength(3);
    expect(log.entries.every((e) => e.offeringId === NF.eng9 && e.offeringName.includes("·"))).toBe(true);
    expect(JSON.stringify(log)).not.toMatch(/Mean words|Worrying|Borderline/);
  });

  it("says when posts are not screened at all", async () => {
    const district = await bootDistrict();
    expect(await district.ok(district.tokenFor(NF.admin), "admin.screeningLog")).toStrictEqual({ screening: "published-unscreened", entries: [], truncated: false });
    const held = await bootDistrict(undefined, { unscreenedStudentPosts: undefined });
    expect((await held.ok(held.tokenFor(NF.admin), "admin.screeningLog")).screening).toBe("held-for-teachers");
  });
});

describe("the sign-in settings", () => {
  it("shows the configured provider, each trusted issuer's people and the deployment's verifier, never a secret", async () => {
    const district = await bootDistrict(undefined, {
      signIn: { verifier: "cloudflare-access", teamDomain: "https://northfield.cloudflareaccess.com", applications: 2 },
    });
    const admin = district.tokenFor(NF.admin);
    const before = await district.ok(admin, "admin.signInSettings");
    expect(before.provider).toBeUndefined();
    await district.ok(admin, "admin.applyConfig", { body: { document: northfieldConfig(), acknowledgeApprovals: true } });

    const settings = await district.ok(admin, "admin.signInSettings");
    const issuer = NORTHFIELD.district.trustedIssuers[0]!;
    const people = NORTHFIELD.principals.filter((p) => p.kind !== "service" && p.externalIdentities.some((i) => i.issuer === issuer));
    expect(settings).toStrictEqual({
      provider: "district-sso",
      issuers: [{
        issuer,
        activePeople: people.filter((p) => p.status === "active").length,
        inactivePeople: people.filter((p) => p.status !== "active").length,
      }],
      activeWithoutSignIn: expect.any(Number),
      pendingLinks: 0,
      deployment: { verifier: "cloudflare-access", teamDomain: "https://northfield.cloudflareaccess.com", applications: 2 },
    });
    expect(settings.issuers[0]!.activePeople).toBeGreaterThan(0);
  });

  it("says nothing about a deployment that did not describe itself", async () => {
    const district = await bootDistrict();
    expect((await district.ok(district.tokenFor(NF.admin), "admin.signInSettings")).deployment).toBeUndefined();
  });
});
