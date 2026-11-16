// The tools EducateOS hosts as an LTI Platform (SCHO-179): a district admin alone registers a tool,
// deploys it to the district's own offerings with services and personal data off unless asked,
// changes and revokes deployments, and revokes a tool together with every deployment of it. Each
// call is decided by the policy engine and every record keeps who changed it last.
import { describe, expect, it } from "vitest";
import { OfferingId } from "@educateos/contracts";
import { InMemoryRecordTable, LtiPlatformToolService, LtiStoredRecordError, PLATFORM_TOOL_COLLECTIONS, TablePlatformToolStore } from "../src/index.ts";
import { ADMIN, as, BIO, createDistrict, ENG9, NF, RIVERA, rejection, SCHOOL_ADMIN } from "./setup.ts";

const TOOL = {
  name: "Quiz Garden",
  loginInitiationUrl: "https://tool.example/lti/login",
  redirectUris: ["https://tool.example/lti/launch"],
  targetLinkUri: "https://tool.example/lti/launch",
  jwksUrl: "https://tool.example/.well-known/jwks.json",
};

function platform() {
  const district = createDistrict();
  const store = new TablePlatformToolStore(district.table);
  const service = new LtiPlatformToolService({ districtId: NF, authorizer: district.engine, directory: district.loadDirectory, store, now: district.clock.now });
  return { district, store, service };
}

describe("LtiPlatformToolService", () => {
  it("registers a tool and deploys it to an offering with no service or personal data unless asked", async () => {
    const { service } = platform();
    const tool = await service.registerTool(as(ADMIN), TOOL);
    expect(tool).toMatchObject({ ...TOOL, districtId: NF, status: "active", registeredBy: ADMIN, updatedBy: ADMIN });
    expect(tool.id).toMatch(/^ltt_/);

    const deployment = await service.deploy(as(ADMIN), { toolId: tool.id, offerings: [BIO] });
    expect(deployment).toMatchObject({
      toolId: tool.id,
      offerings: [BIO],
      services: { nrps: false, agsLineItems: false, agsResults: false, agsScores: false, deepLinking: false },
      privacy: { name: false, email: false },
      status: "active",
      createdBy: ADMIN,
    });
    expect(await service.list(as(ADMIN))).toEqual({ tools: [tool], deployments: [deployment] });
  });

  it("leaves tools to a district admin: a teacher or school admin is refused, and the refusal is audited", async () => {
    const { district, service } = platform();
    for (const caller of [RIVERA, SCHOOL_ADMIN]) {
      expect(await rejection(service.registerTool(as(caller), TOOL))).toBe("forbidden");
      expect(await rejection(service.list(as(caller)))).toBe("forbidden");
    }
    const tool = await service.registerTool(as(ADMIN), TOOL);
    expect(await rejection(service.deploy(as(RIVERA), { toolId: tool.id, offerings: [BIO] }))).toBe("forbidden");
    expect(await rejection(service.revokeTool(as(RIVERA), tool.id))).toBe("forbidden");
    expect(district.audit.filter((event) => event.principalId === RIVERA && event.effect === "deny").length).toBeGreaterThanOrEqual(3);
  });

  it("refuses a malformed tool, an offering not in the district and an unknown tool", async () => {
    const { service } = platform();
    expect(await rejection(service.registerTool(as(ADMIN), { ...TOOL, redirectUris: ["https://elsewhere.example/launch"] }))).toBe("validation-failed");
    const tool = await service.registerTool(as(ADMIN), TOOL);
    expect(await rejection(service.deploy(as(ADMIN), { toolId: tool.id, offerings: [OfferingId.parse("off_other-district")] }))).toBe("validation-failed");
    expect(await rejection(service.deploy(as(ADMIN), { toolId: "ltt_0000000000000000000000", offerings: [BIO] }))).toBe("not-found");
  });

  it("changes a deployment's services and offerings, keeping who changed it", async () => {
    const { district, service } = platform();
    const tool = await service.registerTool(as(ADMIN), TOOL);
    const deployment = await service.deploy(as(ADMIN), { toolId: tool.id, offerings: [BIO] });
    district.clock.ms += 60_000;
    const changed = await service.changeDeployment(as(ADMIN), deployment.id, {
      offerings: [BIO, ENG9],
      services: { nrps: true, agsLineItems: true, agsResults: false, agsScores: true, deepLinking: false },
    });
    expect(changed).toMatchObject({ offerings: [BIO, ENG9], services: { nrps: true, agsScores: true }, privacy: { name: false }, updatedBy: ADMIN });
    expect(changed.updatedAt).not.toBe(deployment.updatedAt);
    expect(changed.createdAt).toBe(deployment.createdAt);
    expect(await rejection(service.changeDeployment(as(RIVERA), deployment.id, { privacy: { name: true, email: true } }))).toBe("forbidden");
  });

  it("revokes a deployment for good, and a tool with every deployment of it", async () => {
    const { service } = platform();
    const tool = await service.registerTool(as(ADMIN), TOOL);
    const first = await service.deploy(as(ADMIN), { toolId: tool.id, offerings: [BIO] });
    const second = await service.deploy(as(ADMIN), { toolId: tool.id, offerings: [ENG9] });

    expect((await service.revokeDeployment(as(ADMIN), first.id)).status).toBe("revoked");
    expect(await rejection(service.changeDeployment(as(ADMIN), first.id, { services: { nrps: true } }))).toBe("conflict");

    expect((await service.revokeTool(as(ADMIN), tool.id)).status).toBe("revoked");
    const { deployments } = await service.list(as(ADMIN));
    expect(deployments.find((d) => d.id === second.id)?.status).toBe("revoked");
    expect(await rejection(service.deploy(as(ADMIN), { toolId: tool.id, offerings: [BIO] }))).toBe("conflict");
    expect(await rejection(service.revokeTool(as(ADMIN), "ltt_0000000000000000000000"))).toBe("not-found");
  });
});

describe("TablePlatformToolStore", () => {
  it("refuses a stored tool that does not match its schema", async () => {
    const table = new InMemoryRecordTable();
    table.put(PLATFORM_TOOL_COLLECTIONS.tools, "ltt_tampered", { id: "ltt_tampered", jwksUrl: "http://insecure.example" });
    await expect(new TablePlatformToolStore(table).tools()).rejects.toBeInstanceOf(LtiStoredRecordError);
  });
});
