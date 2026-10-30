import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import type { WorkshopCapabilityDescriptor } from "@gadgets/workshop-shared/capability-policy";
import { authorizeWorkshopCapability, WorkshopPolicySettings } from "../src/workshop-policy.ts";
import { TEST_CONFIG } from "./fixtures.ts";

const student = "principal:prn_nf-student-amara";
const teacher = "principal:prn_nf-teacher-rivera";
const admin = "principal:prn_nf-district-admin";
const personal = { action: "workspace.create", workspaceId: "new-workspace" } as const;
const classroom = { ...personal, sourceBlueprintId: "english-authoring" };
const model = { action: "model.configure", provider: "cloudflare", modelId: "synthetic-model" } as const;
const connector = { action: "gatekeeper.connect", vendorId: "educateos", accountId: 7, resourceUrlPatterns: ["school://approved"] } as const;
const resource = { action: "resource.acquire", vendorId: "educateos", accountId: 7, resource: "SchoolTools" } as const;
const call = (request: WorkshopCapabilityDescriptor) => env.WORKSHOP_POLICY.authorizeCapability(request);
const outcome = async (request: WorkshopCapabilityDescriptor) => (await call(request)).outcome;

describe("district policy over direct Worker RPC", () => {
  it("permits personal creation and exact approved personal blueprints", async () => {
    expect(await outcome({ ...personal, userId: student })).toBe("allow");
    expect(await outcome({ ...personal, userId: student, sourceBlueprintId: "personal-notebook" })).toBe("allow");
    expect(await outcome({ ...personal, userId: student, sourceBlueprintId: "unapproved" })).toBe("deny");
  });

  it("permits teachers to author only their assigned class", async () => {
    expect(await outcome({ ...classroom, userId: teacher })).toBe("allow");
    expect(await outcome({ ...classroom, userId: student })).toBe("deny");
    expect(await outcome({ ...classroom, userId: "principal:prn_nf-morgan-lee" })).toBe("deny");
  });

  it.each([student, teacher, "principal:prn_nf-principal-high"])("denies configuration to %s even over direct RPC", async (userId) => {
    for (const request of [model, connector, resource]) expect(await outcome({ ...request, userId })).toBe("deny");
  });

  it("allows district administration only within exact deployment grants", async () => {
    for (const request of [model, connector, resource]) expect(await outcome({ ...request, userId: admin })).toBe("allow");
    for (const request of [
      { ...model, provider: "openai" }, { ...model, modelId: "other-model" },
      { ...connector, resourceUrlPatterns: undefined },
      { ...connector, resourceUrlPatterns: [] },
      { ...connector, accountId: 8 }, { ...connector, accountId: undefined },
      { ...connector, resourceUrlPatterns: ["https://external.example/*"] },
      { ...connector, vendorId: "mcp" }, { ...resource, resource: "https://external.example/mcp" },
      { ...resource, resource: "SchoolTools/../mcp" }, { ...resource, vendorId: "educateos:mcp" },
    ]) expect(await outcome({ ...request, userId: admin })).toBe("deny");
  });

  it.each(["prn_nf-district-admin", "email:admin@example.com", "principal:missing", "principal:principal:prn_nf-district-admin", "principal:prn_rb-district-admin"])("denies unverified or unknown user %s", async (userId) => {
    expect(await outcome({ ...personal, userId })).toBe("deny");
  });

  it("rejects role injection, unknown actions, and malformed direct calls", async () => {
    for (const request of [
      { ...model, userId: student, role: "district-admin" },
      { ...personal, userId: student, districtId: NORTHFIELD.district.id },
      { ...personal, userId: student, action: "workspace.publish" },
      { ...personal, userId: student, workspaceId: "" },
    ]) {
      // Generated RPC validation may reject before the domain parser returns its denial.
      let allowed = false;
      try { allowed = (await call(request as never)).outcome === "allow"; } catch { /* fail closed */ }
      expect(allowed).toBe(false);
    }
  });

  it("does not expose authority through public fetch", async () => {
    const response = await SELF.fetch("https://district.example/authorizeCapability", { method: "POST", body: JSON.stringify({ ...model, userId: admin }) });
    expect(response.status).toBe(404);
  });

  it("rechecks role, enrollment and status revocation, including after restart", async () => {
    const object = env.DISTRICT.getByName(NORTHFIELD.district.id);
    expect(await outcome({ ...model, userId: admin })).toBe("allow");
    expect(await outcome({ ...classroom, userId: teacher })).toBe("allow");
    await runInDurableObject(object, async (instance) => {
      const { stores } = await instance.districtApp();
      const { version, snapshot } = await stores.directory.load();
      await stores.directory.commit({ ...snapshot,
        roleAssignments: snapshot.roleAssignments.filter((r) => r.principalId !== "prn_nf-district-admin"),
        enrollments: snapshot.enrollments.map((e) => e.principalId === "prn_nf-teacher-rivera" ? { ...e, status: "inactive" as const } : e),
        principals: snapshot.principals.map((p) => p.id === "prn_nf-student-amara" ? { ...p, status: "inactive" as const } : p),
      }, version);
    });
    for (const request of [{ ...model, userId: admin }, { ...classroom, userId: teacher }, { ...personal, userId: student }]) {
      expect(await outcome(request)).toBe("deny");
    }
    await evictDurableObject(object);
    expect(await outcome({ ...model, userId: admin })).toBe("deny");
  });
});

// Unit-level domain checks share workerd so the real ABAC engine and stores are exercised too.
describe("district policy domain adapter", () => {
  it("denies absent policy and unknown blueprint without consulting the engine", async () => {
    await runInDurableObject(env.DISTRICT.getByName("policy-domain"), async (instance) => {
      const app = await instance.districtApp();
      expect((await authorizeWorkshopCapability(app, undefined, { ...model, userId: admin })).outcome).toBe("deny");
      expect((await authorizeWorkshopCapability(app, TEST_CONFIG.workshopPolicy, { ...personal, userId: student, sourceBlueprintId: "teacher:admin" })).outcome).toBe("deny");
    });
  });

  it("denies disabled personal creation, ambiguous templates, closed terms and missing offerings", async () => {
    await runInDurableObject(env.DISTRICT.getByName("policy-scopes"), async (instance) => {
      const app = await instance.districtApp();
      const settings = TEST_CONFIG.workshopPolicy!;
      const check = async (policy: typeof settings, request: WorkshopCapabilityDescriptor) =>
        (await authorizeWorkshopCapability(app, policy, request)).outcome;
      expect(await check({ ...settings, personalCreation: false }, { ...personal, userId: student })).toBe("deny");
      expect(await check({ ...settings, classBlueprints: [...settings.classBlueprints, ...settings.classBlueprints] }, { ...classroom, userId: teacher })).toBe("deny");
      expect(await check({ ...settings, personalBlueprints: ["english-authoring"] }, { ...classroom, userId: teacher })).toBe("deny");
      expect(await check({ ...settings, classBlueprints: [{ blueprintId: "english-authoring", offeringId: "off_missing" as never }] }, { ...classroom, userId: teacher })).toBe("deny");
      const { snapshot, version } = await app.stores.directory.load();
      await app.stores.directory.commit({ ...snapshot, terms: snapshot.terms.map((t) => ({ ...t, state: "completed" as const })) }, version);
      expect(await check(settings, { ...classroom, userId: teacher })).toBe("deny");
    });
  });

  it("denies expired roles and graduated or foreign principals from live state", async () => {
    await runInDurableObject(env.DISTRICT.getByName("policy-lifecycle"), async (instance) => {
      const app = await instance.districtApp();
      const { snapshot, version } = await app.stores.directory.load();
      await app.stores.directory.commit({ ...snapshot,
        roleAssignments: snapshot.roleAssignments.map((r) => r.principalId === "prn_nf-district-admin" ? { ...r, validUntil: "2020-01-01T00:00:00.000Z" } : r),
        principals: snapshot.principals.map((p) => p.id === "prn_nf-student-amara" ? { ...p, status: "graduated" as const } : p),
      }, version);
      expect((await authorizeWorkshopCapability(app, TEST_CONFIG.workshopPolicy, { ...model, userId: admin })).outcome).toBe("deny");
      expect((await authorizeWorkshopCapability(app, TEST_CONFIG.workshopPolicy, { ...personal, userId: student })).outcome).toBe("deny");
      // Even a known principal cannot authorize through an adapter for a different district.
      expect((await authorizeWorkshopCapability({ ...app, districtId: "dst_other" as never }, TEST_CONFIG.workshopPolicy, { ...personal, userId: teacher })).outcome).toBe("deny");
    });
  });

  it("validates policy strictly", () => {
    expect(WorkshopPolicySettings.safeParse({ ...TEST_CONFIG.workshopPolicy, requestedRole: "admin" }).success).toBe(false);
    expect(WorkshopPolicySettings.safeParse({}).success).toBe(false);
  });
});


it("intentionally disables new authoring actions until district provenance and ABAC mappings exist", async () => {
  for (const userId of [student, teacher, admin]) {
    for (const request of [
      { action: "workspace.create.query", userId },
      { action: "workshop.authoring.query", userId, operation: "create" },
      { action: "blueprint.import", userId },
      ...(["gadget.create", "blueprint.publish", "workspace.share", "gadget.execute", "agent.execute"] as const)
        .map(action => ({ action, userId, workspaceId: "approved-looking-workspace" })),
    ] as WorkshopCapabilityDescriptor[]) {
      // The RPC validator may reject a not-yet-supported discovery union before the domain
      // adapter. Both paths must refuse authority; no other exception counts as this check.
      try {
        expect(await outcome(request)).toBe("deny");
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        expect(String(error)).toContain("capnweb-validate");
      }
      await runInDurableObject(env.DISTRICT.getByName("disabled-authoring"), async instance => {
        expect((await authorizeWorkshopCapability(await instance.districtApp(), TEST_CONFIG.workshopPolicy, request)).outcome).toBe("deny");
      });
    }
  }
});
