import { describe, expect, it } from "vitest";
import { findSecretShapes, validateArchive, type ArtifactRecord } from "../src/index.ts";
import { amarasYear, FORBIDDEN_STRINGS } from "./scenario.ts";
import { doc, entryTexts, O, P, RESOURCE_EXPORT_RULE, rejectsWith, setup, text } from "./setup.ts";

/** Internal ID shapes from `@schoolos/contracts` and `@schoolos/learning-artifacts`. */
const INTERNAL_ID = /\b(?:dst|sch|trm|crs|off|enr|prn|wsp|act|art|sub|rbr|asr|cfg|rev)_[a-z0-9]/;
const decoder = new TextDecoder();
const fixedHex = () => "0123456789abcdef0123456789abcdef";

describe("a student archive round trip", () => {
  it("carries the learner's work, lineage, submissions and shared feedback, and validates", async () => {
    const env = setup();
    const year = await amarasYear(env);

    const exported = await env.exporter.exportStudentArchive(P.amara);
    const archive = await validateArchive(exported.bytes);

    expect(archive.manifest).toMatchObject({
      format: "schoolos.student-archive",
      formatVersion: 1,
      exportId: exported.exportId,
      district: { displayName: "Northfield Public Schools (synthetic)" },
      exportedAt: "2026-10-20T12:00:00.000Z",
    });
    expect(exported.withheld).toEqual([]);

    // The personal essay, with both revisions as a linear chain and their district digests.
    const essay = archive.artifacts.find((a) => a.title === "Cell membranes essay")!;
    expect(essay.context).toEqual({ kind: "personal" });
    expect(essay.revisions.map((r) => [r.id, r.parent, r.digest, r.aiAssistance.level])).toEqual([
      [`${essay.id}-r1`, undefined, year.essay.head.content.digest, "none"],
      [`${essay.id}-r2`, `${essay.id}-r1`, year.essayV2.head.content.digest, "assisted"],
    ]);
    expect(decoder.decode(archive.content(fileOf(essay, 1)))).toBe("Cells are small.");
    expect(decoder.decode(archive.content(fileOf(essay, 2)))).toBe("Cells are small.\n\nMembranes control what enters.");
    expect(new Set(essay.revisions.map((r) => r.author))).toEqual(new Set([archive.manifest.subject]));

    // The closed course's lab, with its course context by name, and the submission pointing at it.
    const lab = archive.artifacts.find((a) => a.title === "Osmosis lab report")!;
    expect(lab.context).toEqual({ kind: "course", course: "Biology I", section: "Period 2", term: "Fall 2026" });
    expect(archive.submissions).toEqual([
      {
        id: "s1",
        activity: "Osmosis lab",
        context: lab.context,
        submittedAt: "2026-10-01T15:00:00.000Z",
        parts: [{ digest: year.lab.head.content.digest, content: { kind: "revision", artifact: lab.id, revision: `${lab.id}-r1` } }],
      },
    ]);
    expect(archive.feedback).toEqual([
      { id: "f1", submission: "s1", author: "staff-1", createdAt: "2026-10-03T09:00:00.000Z", body: "Clear method. Next time, add a control group." },
    ]);

    // Every item has one policy decision, naming the district rule that allowed it.
    expect(archive.provenance.decisions).toEqual(expect.arrayContaining([
      { item: essay.id, action: "export", ruleId: "personal.owner-artifacts" },
      { item: lab.id, action: "export", ruleId: "course.owner.read-own" },
      { item: "s1", action: "export", ruleId: "course.owner.read-own" },
      { item: "f1", action: "export", ruleId: "course.owner.read-own" },
    ]));
  });

  it("cross-maps every district ID to an export-local one, keeping the mapping server-side", async () => {
    const env = setup();
    const year = await amarasYear(env);
    const exported = await env.exporter.exportStudentArchive(P.amara);
    const archive = await validateArchive(exported.bytes);

    for (const [path, body] of await entryTexts(exported.bytes)) {
      if (!path.endsWith(".json")) continue;
      expect(body, path).not.toMatch(INTERNAL_ID);
      // Storage keys are digest-derived; none is carried.
      expect(body, path).not.toContain("sha256/");
    }
    expect(archive.manifest.subject).toMatch(/^learner-[0-9a-f]{16}$/);

    const mapping = env.mappings.get(exported.exportId)!;
    const internal = (local: string) => mapping.entries.find((e) => e.localId === local)?.internalId;
    const lab = archive.artifacts.find((a) => a.title === "Osmosis lab report")!;
    expect(mapping).toMatchObject({ principalId: P.amara.principal.principalId, subject: archive.manifest.subject });
    expect(internal(archive.manifest.subject)).toBe(P.amara.principal.principalId);
    expect(internal(lab.id)).toBe(year.lab.artifact.id);
    expect(internal(`${lab.id}-r1`)).toBe(year.lab.head.id);
    expect(internal("s1")).toBe("sub_amara-osmosis");
    expect(internal("f1")).toBe("fbk_amara-shared");
    expect(internal("staff-1")).toBe(P.morgan.principal.principalId);
  });

  it("never includes tokens or credentials, withholding secret-shaped work and reporting it", async () => {
    const env = setup();
    await amarasYear(env);
    const personal = await env.workspaces.ensurePersonalWorkspace(P.amara);
    await env.artifacts.createArtifact(P.amara, doc(personal.id, "Robotics club\n\napi_key = sk-proj-EXAMPLEexample0123456789abcd", "Club notes"));

    const exported = await env.exporter.exportStudentArchive(P.amara);
    expect(exported.withheld).toEqual([{ kind: "artifact", label: "Club notes", found: ["api-secret-key", "credential-assignment"] }]);

    const archive = await validateArchive(exported.bytes);
    expect(archive.artifacts.map((a) => a.title)).not.toContain("Club notes");
    for (const [path, body] of await entryTexts(exported.bytes)) expect(findSecretShapes(body), path).toEqual([]);
  });
});

describe("what an archive leaves out", () => {
  it("never includes a peer's work or feedback, or a teacher-only note, even from a source that offers them", async () => {
    const env = setup();
    await amarasYear(env);
    const exported = await env.exporter.exportStudentArchive(P.amara);
    const bodies = [...(await entryTexts(exported.bytes)).values()].join("\n");
    for (const forbidden of FORBIDDEN_STRINGS) expect(bodies).not.toContain(forbidden);

    const archive = await validateArchive(exported.bytes);
    expect(archive.submissions).toHaveLength(1);
    expect(archive.feedback).toHaveLength(1);
    // Elena's own export holds her lab and not Amara's.
    const elenas = await validateArchive((await env.exporter.exportStudentArchive(P.elena)).bytes);
    expect(elenas.artifacts.map((a) => a.title)).toEqual(["PEER-TITLE Elena's lab"]);
  });

  it("holds course work back until the course has closed, while submissions still go", async () => {
    const env = setup();
    const bio = await env.workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    const lab = await env.artifacts.createArtifact(P.amara, doc(bio.id, "Draft lab.", "Osmosis lab report"));
    await env.artifacts.saveRevision(P.amara, lab.artifact.id, text("Final lab."));
    env.records.submissionRecords.push({
      id: "sub_amara-osmosis" as never,
      ownerPrincipalId: P.amara.principal.principalId,
      offeringId: O.bioFall,
      activityTitle: "Osmosis lab",
      submittedAt: "2026-10-01T15:00:00.000Z",
      revisions: [{ artifactId: lab.artifact.id, revisionId: lab.head.id, digest: lab.head.content.digest }],
    });

    const during = await validateArchive((await env.exporter.exportStudentArchive(P.amara)).bytes);
    expect(during.artifacts).toEqual([]);
    // The submitted snapshot travels as the submission's own file, the draft it captured.
    const part = during.submissions[0]!.parts[0]!;
    expect(part.content).toMatchObject({ kind: "file", mediaType: "text/markdown" });
    expect(decoder.decode(during.content((part.content as { path: string }).path))).toBe("Draft lab.");

    await env.completeFallTerm();
    const after = await validateArchive((await env.exporter.exportStudentArchive(P.amara)).bytes);
    expect(after.artifacts.map((a) => [a.title, a.revisions.length])).toEqual([["Osmosis lab report", 2]]);
    expect(after.submissions[0]!.parts[0]!.content).toEqual({ kind: "revision", artifact: "a1", revision: "a1-r1" });
  });

  it("refuses a principal outside the directory", async () => {
    const env = setup();
    await rejectsWith(env.exporter.exportStudentArchive({ ...P.amara, principal: { ...P.amara.principal, principalId: "prn_nobody" as never } }), "not-found");
  });
});

describe("source rights", () => {
  it("exports a link-only resource and a learner's own link as references, never content, stripped of tokens", async () => {
    const env = setup({ extraRules: [RESOURCE_EXPORT_RULE] });
    await amarasYear(env);
    const exported = await env.exporter.exportStudentArchive(P.amara);
    const archive = await validateArchive(exported.bytes);

    const page = archive.resources.find((r) => r.title === "How cells work")!;
    expect(page).toEqual({ id: page.id, title: "How cells work", reference: { url: "https://publisher.example/cells" } });
    expect(archive.manifest.items.find((i) => i.path === `resources/${page.id}/resource.json`)!.rights).toEqual({ mode: "link" });

    const notes = archive.artifacts.find((a) => a.type === "external-ref")!;
    expect(notes.revisions[0]!.content).toEqual({ kind: "reference", url: "https://docs.northfield.example/d/notes-1" });
    expect(archive.manifest.items.find((i) => i.path === `artifacts/${notes.id}/artifact.json`)!.rights).toEqual({ mode: "link" });
    expect(archive.manifest.items.filter((i) => i.path.startsWith(`artifacts/${notes.id}/`))).toHaveLength(1);
  });

  it("copies a resource only when policy allows the export and its rights permit redistribution", async () => {
    const env = setup({ extraRules: [RESOURCE_EXPORT_RULE] });
    await amarasYear(env);
    const archive = await validateArchive((await env.exporter.exportStudentArchive(P.amara)).bytes);

    const excerpt = archive.resources.find((r) => r.title === "Diffusion, an excerpt")!;
    expect(decoder.decode(archive.content(excerpt.content!.path))).toBe("Diffusion moves particles from high to low concentration.");
    expect(archive.manifest.items.find((i) => i.path === excerpt.content!.path)!.rights).toEqual({ mode: "permitted-excerpt", redistribution: "permitted", license: "CC-BY-4.0" });

    // The licensed textbook may not be redistributed: a reference to the publisher, and its copy is never even read.
    const textbook = archive.resources.find((r) => r.title === "Biology textbook, chapter 3")!;
    expect(textbook).toEqual({ id: textbook.id, title: textbook.title, reference: { url: "https://publisher.example/textbook/ch3" } });
    expect(env.records.contentReads).toEqual(["res-diffusion-excerpt"]);
    // The answer key is teacher-only, so the learner may not even read it: not even a reference.
    expect(archive.resources.map((r) => r.title)).not.toContain("STAFF-ONLY Osmosis answer key");
  });

  it("without a district rule to export resources, cites them as references only", async () => {
    const env = setup();
    await amarasYear(env);
    const exported = await env.exporter.exportStudentArchive(P.amara);
    const archive = await validateArchive(exported.bytes);
    expect(archive.resources.map((r) => [r.title, r.content === undefined])).toEqual([
      ["How cells work", true],
      ["Biology textbook, chapter 3", true],
    ]);
    expect(archive.provenance.decisions.filter((d) => d.item.startsWith("res"))).toEqual([
      { item: "res1", action: "read", ruleId: "curriculum.published.read" },
      { item: "res2", action: "read", ruleId: "curriculum.published.read" },
    ]);
    expect(env.records.contentReads).toEqual([]);
  });
});

describe("determinism", () => {
  it("gives identical bytes for the same records, clock and export ID", async () => {
    const env = setup({ randomHex: fixedHex });
    await amarasYear(env);
    const first = await env.exporter.exportStudentArchive(P.amara);
    const second = await env.exporter.exportStudentArchive(P.amara);
    expect(second.bytes).toEqual(first.bytes);

    env.clock.now = new Date("2026-10-21T12:00:00Z");
    const later = await env.exporter.exportStudentArchive(P.amara);
    expect(later.bytes).not.toEqual(first.bytes);
  });
});

function fileOf(artifact: ArtifactRecord, number: number): string {
  const content = artifact.revisions.find((r) => r.number === number)!.content;
  if (content.kind !== "file") throw new Error("not a file");
  return content.path;
}
