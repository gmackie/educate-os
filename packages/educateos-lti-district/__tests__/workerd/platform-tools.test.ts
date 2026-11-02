// The LTI Platform's tools and deployments (SCHO-179) over `DurableObjectRecordTable`, in workerd,
// against real Durable Object SQLite storage: they survive a restart of the object, a tool's
// revocation reaches every deployment of it in one step, and no deployment is stored for a revoked
// tool, even when deploys race the revocation.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DistrictId, OfferingId, PrincipalId } from "@educateos/contracts";
import { newPlatformDeploymentId, newPlatformToolId, type PlatformDeployment, type PlatformTool } from "@educateos/lti";
import { DurableObjectRecordTable } from "../../src/durable-object.ts";
import { TablePlatformToolStore } from "../../src/platform-tools.ts";

const NF = DistrictId.parse("dst_northfield");
const BIO = OfferingId.parse("off_nf-bio-fall-p2");
const ADMIN = PrincipalId.parse("prn_nf-district-admin");
const AT = "2026-10-31T12:00:00.000Z";

let objects = 0;
const fresh = () => env.LTI.getByName(`platform-tools-${objects++}`);

const tool: PlatformTool = {
  id: newPlatformToolId(),
  districtId: NF,
  name: "Quiz Garden",
  loginInitiationUrl: "https://tool.example/lti/login",
  redirectUris: ["https://tool.example/lti/launch"],
  targetLinkUri: "https://tool.example/lti/launch",
  jwksUrl: "https://tool.example/.well-known/jwks.json",
  status: "active",
  registeredBy: ADMIN,
  registeredAt: AT,
  updatedBy: ADMIN,
  updatedAt: AT,
};

const deployment = (): PlatformDeployment => ({
  id: newPlatformDeploymentId(),
  districtId: NF,
  toolId: tool.id,
  offerings: [BIO],
  services: { nrps: true, agsLineItems: false, agsResults: false, agsScores: false, deepLinking: false },
  privacy: { name: false, email: false },
  status: "active",
  createdBy: ADMIN,
  createdAt: AT,
  updatedBy: ADMIN,
  updatedAt: AT,
});

/** Runs `step` with the platform tool store over the object's own SQLite storage. */
function withStore<T>(stub: ReturnType<typeof fresh>, step: (store: TablePlatformToolStore) => Promise<T>): Promise<T> {
  return runInDurableObject(stub, (_instance, state) => step(new TablePlatformToolStore(new DurableObjectRecordTable(state.storage))));
}

describe("platform tools in a Durable Object", () => {
  it("keeps tools and deployments across a restart", async () => {
    const district = fresh();
    const deployed = deployment();
    await withStore(district, async (store) => {
      await store.addTool(tool);
      await store.putDeployment(deployed);
    });
    await evictDurableObject(district);
    await withStore(district, async (store) => {
      expect(await store.tool(tool.id)).toEqual(tool);
      expect(await store.deployments()).toEqual([deployed]);
    });
  });

  it("revokes every deployment with its tool, and stores none for it after, even racing", async () => {
    const district = fresh();
    await withStore(district, async (store) => {
      await store.addTool(tool);
      await Promise.all(Array.from({ length: 5 }, () => store.putDeployment(deployment())));
      const racing = await Promise.allSettled([
        ...Array.from({ length: 5 }, () => store.putDeployment(deployment())),
        store.revokeTool(tool.id, ADMIN, AT),
        ...Array.from({ length: 5 }, () => store.putDeployment(deployment())),
      ]);
      expect(racing.filter((r) => r.status === "rejected").length).toBeGreaterThan(0);
    });
    await evictDurableObject(district);
    await withStore(district, async (store) => {
      expect((await store.tool(tool.id))?.status).toBe("revoked");
      const deployments = await store.deployments();
      expect(deployments.length).toBeGreaterThanOrEqual(5);
      expect(deployments.every((d) => d.status === "revoked")).toBe(true);
    });
  });
});
