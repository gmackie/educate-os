// Named CASE adapters (ADR-0011) and the TEA teks-api adapter (SCHO-61). The fixtures are
// hand-authored to the shape of TEA's responses (field names, types, item types, nesting and
// statement patterns) with synthetic text; TEA's terms do not let this repository ship TEKS text.
import { describe, expect, it } from "vitest";
import {
  type CaseAdapter,
  CaseClient,
  type CaseFetch,
  CaseDocumentSet,
  adaptCaseDocumentSet,
  adaptCasePackage,
  caseAdapter,
  decodeCasePackage,
  encodeCasePackage,
  type Provenance,
  TEA_TEKS_ADAPTER,
} from "../src/index.ts";
import teaListing from "./fixtures/tea-teks-shaped-listing.json" with { type: "json" };
import teaPackage from "./fixtures/tea-teks-shaped-package.json" with { type: "json" };

const BASE = "https://teks-api.texasgateway.example/ims/case/v1p0";
const official: Provenance = {
  source: "official",
  sourceUri: `${BASE}/CFDocuments/${teaPackage.CFDocument.identifier}`,
  retrievedAt: "2026-10-21T00:00:00Z",
  sourceRevision: "1.1.2",
};

const copy = <T>(value: T): T => structuredClone(value);
const itemId = (code: string) => teaPackage.CFItems.find((item) => item.humanCodingScheme === code)!.identifier;

function decodeTea(raw: unknown = copy(teaPackage)) {
  const { value, adaptations } = adaptCasePackage(raw, TEA_TEKS_ADAPTER);
  return decodeCasePackage(value, official, adaptations);
}

const nodeFor = (release: ReturnType<typeof decodeTea>, code: string) => release.nodes!.find((n) => n.humanCodingScheme === code)!;

async function rejectsWith(run: () => unknown, code: string, message?: RegExp): Promise<void> {
  await expect((async () => run())()).rejects.toMatchObject({ name: "SchoolOsError", code, ...(message ? { message: expect.stringMatching(message) } : {}) });
}

describe("the strict CASE 1.1 decoder (SCHO-45: stays fail-closed)", () => {
  it("still refuses a TEA package as TEA sends it, naming the deviation", async () => {
    await rejectsWith(() => decodeCasePackage(copy(teaPackage), official), "validation-failed", /CFDocument\.subject/);
  });

  it("still refuses a field CASE does not define, even through an adapter", async () => {
    const raw = copy(teaPackage) as { CFItems: Array<Record<string, unknown>> };
    raw.CFItems[0]!["gradeBand"] = "K-5";
    await rejectsWith(() => adaptCasePackage(raw, TEA_TEKS_ADAPTER), "validation-failed", /tea-teks-api@1/);
  });

  it("refuses adaptations naming a record the package does not contain, or a listing", async () => {
    const { value, adaptations } = adaptCasePackage(copy(teaPackage), TEA_TEKS_ADAPTER);
    const stray = { ...adaptations[0]!, target: { kind: "item" as const, identifier: "00000000-0000-4000-8000-000000000000" } };
    await rejectsWith(() => decodeCasePackage(value, official, [stray]), "validation-failed");
    await rejectsWith(() => decodeCasePackage(value, official, [{ ...stray, target: { kind: "listing" } }]), "validation-failed");
  });

  it("refuses an adapter that reports changes under another adapter's name", async () => {
    const impostor: CaseAdapter = {
      id: "other-adapter@1",
      adaptPackage: (raw) => TEA_TEKS_ADAPTER.adaptPackage(raw),
      adaptDocumentSet: (raw) => TEA_TEKS_ADAPTER.adaptDocumentSet(raw),
    };
    await rejectsWith(() => adaptCasePackage(copy(teaPackage), impostor), "validation-failed", /malformed adaptations/);
  });
});

describe("the TEA teks-api adapter", () => {
  it("is the shipped adapter named tea-teks-api", () => {
    expect(caseAdapter("tea-teks-api")).toBe(TEA_TEKS_ADAPTER);
  });

  it("turns the string subject into a list and records it on the framework's provenance only", () => {
    const release = decodeTea();
    expect(release.framework.subjects).toStrictEqual(["Mathematics"]);
    expect(release.framework.provenance).toStrictEqual({
      ...official,
      adaptations: [{ adapter: "tea-teks-api@1", field: "CFDocument.subject", change: "string-to-list" }],
    });
    // Source stays official: the adapter reshaped a field, it changed no words.
    expect(release.nodes!.every((node) => node.provenance.source === "official")).toBe(true);
  });

  it("derives education levels from the grade or course each item sits under, and records each one", () => {
    const release = decodeTea();
    const levels = (code: string) => nodeFor(release, code).educationLevels;
    expect(levels("900.2")).toStrictEqual(["KG"]);
    expect(levels("900.2.b.1.A")).toStrictEqual(["KG"]);
    expect(levels("900.5.b.1.A")).toStrictEqual(["03"]);
    expect(levels("900.27.b.1.A")).toStrictEqual(["07", "08"]);
    // A middle-school course that names its grade takes the grade, not the whole division.
    expect(levels("900.31.")).toStrictEqual(["08"]);
    // High-school courses name no grade; they take their division, directly or through an introduction.
    expect(levels("900.39.b.1.A")).toStrictEqual(["09", "10", "11", "12"]);
    expect(levels("900.41.c.1.A")).toStrictEqual(["09", "10", "11", "12"]);
    expect(nodeFor(release, "900.27.b.1.A").provenance.adaptations).toStrictEqual([
      { adapter: "tea-teks-api@1", field: "educationLevel", change: "derived-education-level", detail: "from Grade/Course 900.27" },
    ]);
  });

  it("leaves items with no course or division above them without levels or adaptations", () => {
    const release = decodeTea();
    for (const code of ["900.1", "900.30."]) {
      expect(nodeFor(release, code).educationLevels, code).toBeUndefined();
      expect(nodeFor(release, code).provenance.adaptations, code).toBeUndefined();
    }
  });

  it("keeps an education level the publisher did give, and records nothing for it", () => {
    const raw = copy(teaPackage) as { CFItems: Array<Record<string, unknown>> };
    const item = raw.CFItems.find((i) => i["identifier"] === itemId("900.5.b.1.A"))!;
    item["educationLevel"] = ["03", "04"];
    const node = nodeFor(decodeTea(raw), "900.5.b.1.A");
    expect(node.educationLevels).toStrictEqual(["03", "04"]);
    expect(node.provenance.adaptations).toBeUndefined();
  });

  it("does not modify the response it was given", () => {
    const raw = copy(teaPackage);
    adaptCasePackage(raw, TEA_TEKS_ADAPTER);
    expect(raw).toStrictEqual(teaPackage);
  });

  it("encodes back to strict CASE 1.1", () => {
    const pkg = encodeCasePackage(decodeTea());
    expect(pkg.CFDocument.subject).toStrictEqual(["Mathematics"]);
    expect(pkg.CFItems!.find((i) => i.humanCodingScheme === "900.2.b.1.A")!.educationLevel).toStrictEqual(["KG"]);
  });

  it("wraps the bare-array listing and drops its null optional fields, recording both", () => {
    expect(CaseDocumentSet.safeParse(teaListing).success).toBe(false);
    const { value, adaptations } = adaptCaseDocumentSet(copy(teaListing), TEA_TEKS_ADAPTER);
    expect(value.CFDocuments.map((d) => d.subject)).toStrictEqual([["Mathematics"], ["Prekindergarten"]]);
    expect(value.CFDocuments[1]).not.toHaveProperty("publisher");
    expect(adaptations.filter((a) => a.change === "listing-wrapped")).toStrictEqual([
      { adapter: "tea-teks-api@1", field: "CFDocuments", change: "listing-wrapped", target: { kind: "listing" } },
    ]);
    const second = adaptations.filter((a) => a.target.kind === "document" && a.target.identifier === teaListing[1]!.identifier);
    expect(second.map((a) => `${a.field}:${a.change}`).toSorted()).toStrictEqual([
      "CFDocument.description:null-omitted",
      "CFDocument.licenseURI:null-omitted",
      "CFDocument.notes:null-omitted",
      "CFDocument.officialSourceURL:null-omitted",
      "CFDocument.publisher:null-omitted",
      "CFDocument.subject:string-to-list",
      "CFDocument.version:null-omitted",
    ]);
  });
});

const serve = (body: unknown): CaseFetch => async () =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("the CASE client with an adapter", () => {
  it("fetches an adapted package whose adaptations decode onto provenance", async () => {
    const client = new CaseClient({ baseUrl: BASE, fetch: serve(teaPackage) });
    await rejectsWith(() => client.getPackage(teaPackage.CFDocument.identifier), "validation-failed");
    const { value, adaptations } = await client.getAdaptedPackage(TEA_TEKS_ADAPTER, teaPackage.CFDocument.identifier);
    const release = decodeCasePackage(value, official, adaptations);
    expect(nodeFor(release, "900.2.b.1.A").educationLevels).toStrictEqual(["KG"]);
  });

  it("lists TEA's bare-array listing only through the adapter", async () => {
    const client = new CaseClient({ baseUrl: BASE, fetch: serve(teaListing) });
    await rejectsWith(() => client.listDocuments(), "validation-failed");
    const { value } = await client.listAdaptedDocuments(TEA_TEKS_ADAPTER);
    expect(value.CFDocuments).toHaveLength(2);
  });
});
