import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { BlueprintMetadata } from "@gadgets/workshop-shared/api";
import { buildBlueprintArchiveStream, parseBlueprintArchive, readBlueprintReleaseSource } from "../src/blueprint-archive";
import { buildReleasePack, buildSnapshotRelease, listReleaseFiles, readReleasePack } from "../src/blueprint-release";
import { pinWorkshopAssessmentBlueprint, verifyWorkshopAssessmentBlueprint, WORKSHOP_ASSESSMENT_FILE } from "../../educateos-assessment-sdk/src/workshop.ts";
import { demoDefinition, demoProvider } from "../../educateos-assessment-sdk/examples/demo.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      ASSESSMENT_RELEASES: Service<import("../src/assessment-releases.ts").WorkshopAssessmentReleases>;
    }
  }
}

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

describe("assessment pins from Workshop release packs (workerd)", () => {
  it("reads real R2 release objects, preserves the public definition across .gadget export/import", async () => {
    const published = await publish("assessment-roundtrip");
    const source = await readBlueprintReleaseSource(env, "assessment-roundtrip", published.commitId);
    const pin = await pinWorkshopAssessmentBlueprint("assessment-roundtrip", source);
    expect(pin.blueprint.commitId).toBe(published.commitId);
    const metadata: BlueprintMetadata = {
      title: "Observation", description: "Public task", author: { type: "user", id: "publisher", name: "Publisher" },
      created: new Date(0), lastUpdated: new Date(0), version: 1, bindings: {}, commitId: published.commitId,
    };
    const archive = buildBlueprintArchiveStream(metadata, new Blob([published.pack]).stream(), published.pack.length);
    const imported = await parseBlueprintArchive(archive);
    const bytes = new Uint8Array(await new Response(imported.content).arrayBuffer());
    const objects = await readReleasePack(bytes, imported.metadata.commitId!);
    expect(listReleaseFiles(objects, published.commitId)).toEqual(published.files);
    await env.BLUEPRINT_CONTENT.put(`imported/${published.commitId}`, bytes);
    const restored = await pinWorkshopAssessmentBlueprint("imported", await readBlueprintReleaseSource(env, "imported", published.commitId));
    expect(restored.assessmentDigest).toBe(pin.assessmentDigest);
    expect(restored.blueprint.sourceDigest).toBe(pin.blueprint.sourceDigest);
  });

  it("keeps old pins readable after publishing an update and refuses missing or corrupted packs", async () => {
    const first = await publish("assessment-update");
    const second = await publish("assessment-update", "export default { revised: true }");
    const old = await readBlueprintReleaseSource(env, "assessment-update", first.commitId);
    const latest = await readBlueprintReleaseSource(env, "assessment-update", second.commitId);
    expect(latest.commitId).not.toBe(old.commitId);
    expect(latest.sourceDigest).not.toBe(old.sourceDigest);
    expect(await readBlueprintReleaseSource(env, "assessment-update", first.commitId)).toEqual(old);
    await expect(readBlueprintReleaseSource(env, "assessment-update", "0".repeat(40))).rejects.toThrow("not found");
    await expect(readBlueprintReleaseSource(env, "assessment-update", "../latest")).rejects.toThrow();
    await env.BLUEPRINT_CONTENT.put(`assessment-corrupt/${first.commitId}`, second.pack);
    await expect(readBlueprintReleaseSource(env, "assessment-corrupt", first.commitId)).rejects.toThrow();
  });

  it("verifies through the actual release service binding, never resolving an old pin to latest", async () => {
    // Assimilate native RPC promises before handing them to Vitest assertions.
    const read = async (id: string, commit: string) => await env.ASSESSMENT_RELEASES.getBlueprintRelease(id, commit);
    const first = await publish("bound-assessment");
    const pin = await pinWorkshopAssessmentBlueprint("bound-assessment",
      await env.ASSESSMENT_RELEASES.getBlueprintRelease("bound-assessment", first.commitId));
    await publish("bound-assessment", "export default { updated: true }");
    expect(await verifyWorkshopAssessmentBlueprint(pin, env.ASSESSMENT_RELEASES)).toEqual(pin);
    const exported = await env.ASSESSMENT_RELEASES.getBlueprintRelease("bound-assessment", first.commitId);
    expect(Object.keys(exported).toSorted()).toEqual(["commitId", "files", "sourceDigest"]);
    expect(exported.files).toEqual([...first.files].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    // Possession of an R2 path alone cannot expose an unpublished Gadget or a reserved KV record.
    await env.BLUEPRINT_CONTENT.put(`unpublished/${first.commitId}`, first.pack);
    await expect(read("unpublished", first.commitId)).rejects.toThrow("not found");
    await expect(read(".adminConfig", first.commitId)).rejects.toThrow("not found");
    await expect(read("../bound-assessment", first.commitId)).rejects.toThrow("not found");
    await env.BLUEPRINT_CONTENT.put(`bound-assessment/${first.commitId}`, new Uint8Array([0, 1, 2]));
    await expect(verifyWorkshopAssessmentBlueprint(pin, env.ASSESSMENT_RELEASES)).rejects.toThrow("verification failed");
    await env.BLUEPRINTS.delete("bound-assessment");
    await expect(read("bound-assessment", first.commitId)).rejects.toThrow("not found");
  });
});
