import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildReleasePack, buildSnapshotRelease } from "../src/blueprint-release";
import { pinWorkshopAssessmentBlueprint, verifyWorkshopAssessmentBlueprint, WORKSHOP_ASSESSMENT_FILE } from "../../educateos-assessment-sdk/src/workshop.ts";
import { demoDefinition, demoProvider } from "../../educateos-assessment-sdk/examples/demo.ts";

// The district's release verification capability (SCHO-288), over the backend's own entrypoint
// with the deployment's real BLUEPRINTS and BLUEPRINT_CONTENT bindings.
const releases = exports.WorkshopAssessmentReleases;

async function publish(id: string, code = "export default {}") {
  const files = new Map([
    ["main.ts", code],
    [WORKSHOP_ASSESSMENT_FILE, JSON.stringify(demoDefinition(await demoProvider()))],
  ]);
  const { commitId, objects } = await buildSnapshotRelease(files);
  const pack = await buildReleasePack(oid => objects.get(oid), commitId);
  await env.BLUEPRINT_CONTENT.put(`${id}/${commitId}`, pack);
  await env.BLUEPRINTS.put(id, JSON.stringify({ metadata: {
    title: "Public assessment", created: new Date(0), lastUpdated: new Date(0), commitId,
    version: 1, description: "Public task", bindings: {},
    author: { type: "user", id: "publisher", name: "Publisher" },
  } }));
  return { commitId, pack, files };
}

describe("WorkshopAssessmentReleases", () => {
  it("verifies exact published releases, never resolving an old pin to latest", async () => {
    // Assimilate native RPC promises before handing them to Vitest assertions.
    const read = async (id: string, commit: string) => await releases.getBlueprintRelease(id, commit);
    const first = await publish("bound-assessment");
    const pin = await pinWorkshopAssessmentBlueprint("bound-assessment", await read("bound-assessment", first.commitId));
    await publish("bound-assessment", "export default { updated: true }");
    expect(await verifyWorkshopAssessmentBlueprint(pin, releases)).toEqual(pin);
    const exported = await read("bound-assessment", first.commitId);
    expect(Object.keys(exported).toSorted()).toEqual(["commitId", "files", "sourceDigest"]);
    expect(exported.files).toEqual([...first.files].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    // Possession of an R2 path alone cannot expose an unpublished Gadget or a reserved KV record.
    await env.BLUEPRINT_CONTENT.put(`unpublished/${first.commitId}`, first.pack);
    await expect(read("unpublished", first.commitId)).rejects.toThrow("not found");
    await expect(read(".adminConfig", first.commitId)).rejects.toThrow("not found");
    await expect(read("../bound-assessment", first.commitId)).rejects.toThrow("not found");
    await env.BLUEPRINT_CONTENT.put(`bound-assessment/${first.commitId}`, new Uint8Array([0, 1, 2]));
    await expect(verifyWorkshopAssessmentBlueprint(pin, releases)).rejects.toThrow("verification failed");
    await env.BLUEPRINTS.delete("bound-assessment");
    await expect(read("bound-assessment", first.commitId)).rejects.toThrow("not found");
  });
});
