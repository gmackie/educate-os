// SCHO-367: the district export streams. Its manifest is known before any held content is read,
// content is read only as the ZIP stream is pulled, a read that fails errors the stream rather
// than ending it early, and the route answers the ZIP itself with its download headers. Weekly
// notes, which their store keeps by week with no listing, are found across the term.
import { describe, expect, it } from "vitest";
import { readZip } from "@educateos/zip";
import { PrincipalId } from "@educateos/contracts";
import { buildDistrictExport, DistrictExportManifest } from "../src/index.ts";
import { bootDistrict, NF, studentSubmitsEssay, teacherSetsUpEssay } from "./support.ts";

const LIMITS = { maxEntries: 10_000, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxCompressionRatio: 1_000 };
const ADMIN = PrincipalId.parse("prn_nf-district-admin");

async function seeded() {
  const district = await bootDistrict();
  const teacher = district.tokenFor(NF.rivera);
  const { assignment } = await teacherSetsUpEssay(district, teacher);
  await studentSubmitsEssay(district, assignment.id);
  await district.ok(teacher, "teacher.setWeeklyNote", { params: { offeringId: NF.eng9 }, body: { text: "WEEKLY-NOTE-SCHO-367" } });
  let reads = 0;
  const read = district.stores.artifactContent.read.bind(district.stores.artifactContent);
  district.stores.artifactContent.read = async (ref) => {
    reads += 1;
    return read(ref);
  };
  return { district, reads: () => reads };
}

describe("the streamed district export (SCHO-367)", () => {
  it("reads no held content until the stream reaches it, and all of it once read through", async () => {
    const { district, reads } = await seeded();
    const { snapshot } = await district.stores.directory.load();
    const exported = await buildDistrictExport(district.stores, snapshot, ADMIN, new Date());
    expect(reads()).toBe(0);
    const reader = exported.body.getReader();
    const chunks: Uint8Array[] = [];
    let next = await reader.read();
    // The first pull writes the manifest's entry, and reads nothing held.
    expect(reads()).toBe(0);
    for (; next.done !== true; next = await reader.read()) chunks.push(next.value);

    const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.byteLength, 0));
    chunks.reduce((at, chunk) => (bytes.set(chunk, at), at + chunk.byteLength), 0);
    const zip = await readZip(bytes, LIMITS);
    const manifest = DistrictExportManifest.parse(JSON.parse(new TextDecoder().decode(zip.files.get("manifest.json")!)));
    expect(manifest).toStrictEqual(exported.manifest);
    expect(reads()).toBeGreaterThan(0);
    expect(reads()).toBeLessThanOrEqual(manifest.counts.contentFiles);
    const notes = JSON.parse(new TextDecoder().decode(zip.files.get(`offerings/${NF.eng9}/weekly-notes.json`)!)) as { text: string }[];
    expect(notes.map((n) => n.text)).toStrictEqual(["WEEKLY-NOTE-SCHO-367"]);
    expect(manifest.counts.weeklyNotes).toBe(1);
  });

  it("errors the stream when held content cannot be read, so no one keeps a short archive", async () => {
    const { district } = await seeded();
    district.stores.artifactContent.read = async () => {
      throw new Error("content went missing");
    };
    const { snapshot } = await district.stores.directory.load();
    const exported = await buildDistrictExport(district.stores, snapshot, ADMIN, new Date());
    await expect(new Response(exported.body).arrayBuffer()).rejects.toThrow("content went missing");
  });

  it("answers the ZIP itself, as a download, to a district administrator", async () => {
    const district = await bootDistrict();
    const response = await district.app.fetch(new Request("https://district.example/api/admin/district/export.zip", {
      headers: { authorization: `Bearer ${district.tokenFor(ADMIN)}` },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="dst_northfield-\d{4}-\d{2}-\d{2}\.zip"$/);
    const zip = await readZip(new Uint8Array(await response.arrayBuffer()), LIMITS);
    expect([...zip.files.keys()][0]).toBe("manifest.json");
  });
});
