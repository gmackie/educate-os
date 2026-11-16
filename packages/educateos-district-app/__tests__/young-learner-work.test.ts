// SCHO-323: a young learner's drawing and recording travel the same artifact path as any upload,
// from the student's save to the teacher's review, and the district checks what each file is.
import { describe, expect, it } from "vitest";
import { UPLOAD_MEDIA_TYPES } from "../src/index.ts";
import { bootDistrict, expectError, NF, type TestDistrict } from "./support.ts";

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part)));

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
/** The start of a recording each browser makes, and of the files a student might upload instead. */
const AUDIO = {
  "audio/webm": bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]),
  "audio/ogg": bytes("OggS", [0x00, 0x02]),
  "audio/mp4": bytes([0x00, 0x00, 0x00, 0x1c], "ftypM4A ", [0x00]),
  "audio/mpeg": bytes("ID3", [0x04, 0x00]),
  "audio/wav": bytes("RIFF", [0x24, 0x00, 0x00, 0x00], "WAVEfmt "),
} as const;

async function pictureResponseIn(district: TestDistrict) {
  const rivera = district.tokenFor(NF.rivera);
  const draft = await district.ok(rivera, "teacher.createActivity", {
    params: { offeringId: NF.eng9 },
    body: {
      activity: {
        template: "picture-response",
        title: "My favourite place",
        subject: "english-language-arts",
        gradeBand: "K-2",
        overview: "Show us a place you love.",
        aiHelp: "none",
        due: { kind: "none" },
        lookPrompt: "Think of a place you love.",
        drawPrompt: "Draw your favourite place.",
        sentenceFrames: ["My place is ___."],
      },
    },
  });
  await district.ok(rivera, "teacher.publishActivity", { params: { definitionId: draft.id } });
  return district.ok(rivera, "teacher.installActivity", { params: { definitionId: draft.id }, body: { offeringId: NF.eng9 } });
}

describe("young learners' drawings and recordings", () => {
  it("accepts every audio type a browser records, and keeps the file exactly", async () => {
    expect(UPLOAD_MEDIA_TYPES).toEqual(expect.arrayContaining(Object.keys(AUDIO)));
    const district = await bootDistrict();
    const amara = district.tokenFor(NF.amara);
    const workspace = await district.ok(amara, "student.openCourseWorkspace", { params: { offeringId: NF.eng9 } });
    for (const [mediaType, recording] of Object.entries(AUDIO)) {
      const created = await district.ok(amara, "student.createArtifact", {
        body: { workspaceId: workspace.id, type: "audio", title: `Telling (${mediaType})`, content: { kind: "bytes", mediaType: mediaType as keyof typeof AUDIO, base64: base64(recording) } },
      });
      expect(created.head).toMatchObject({ mediaType, sizeBytes: recording.byteLength, content: { backend: "r2" } });
      const read = await district.ok(amara, "student.getArtifact", { params: { artifactId: created.artifact.id } });
      expect(read.content).toStrictEqual({ kind: "bytes", base64: base64(recording) });
    }
  });

  it("refuses a file that claims to be a recording but is not one", async () => {
    const district = await bootDistrict();
    const amara = district.tokenFor(NF.amara);
    const workspace = await district.ok(amara, "student.openCourseWorkspace", { params: { offeringId: NF.eng9 } });
    const upload = (mediaType: string, content: Uint8Array) =>
      district.call(amara, "student.createArtifact", { body: { workspaceId: workspace.id, type: "audio", title: "Telling", content: { kind: "bytes", mediaType, base64: base64(content) } } as never });
    // An executable, a PNG and a WebM, each claiming the wrong type.
    expectError(await upload("audio/webm", bytes([0x4d, 0x5a, 0x90, 0x00])), 400, "validation-failed");
    expectError(await upload("audio/mp4", PNG), 400, "validation-failed");
    expectError(await upload("audio/wav", bytes("RIFF", [0, 0, 0, 0], "AVI ")), 400, "validation-failed");
    expectError(await upload("audio/ogg", AUDIO["audio/webm"]), 400, "validation-failed");
    // A type off the list is refused whatever its contents.
    expectError(await upload("audio/x-aiff", bytes("FORM")), 400, "validation-failed");
    expect(await district.ok(amara, "student.listArtifacts", { params: { workspaceId: workspace.id } })).toStrictEqual([]);
  });

  it("submits a picture response's drawing and recording, which the teacher reads back as submitted", async () => {
    const district = await bootDistrict();
    const { assignment } = await pictureResponseIn(district);
    expect(assignment.permittedArtifactTypes).toStrictEqual(["image", "audio"]);
    const amara = district.tokenFor(NF.amara);
    const [listed] = (await district.ok(amara, "student.listActivities", { params: { offeringId: NF.eng9 } })).filter((a) => a.assignment.id === assignment.id);
    expect(listed!.activity.content.steps.map((s) => [s.id, s.response, s.sentenceFrames])).toStrictEqual([
      ["look", { kind: "none" }, undefined],
      ["draw", { kind: "artifact", artifactType: "image" }, undefined],
      ["tell", { kind: "artifact", artifactType: "audio" }, ["My place is ___."]],
    ]);

    const workspace = await district.ok(amara, "student.openCourseWorkspace", { params: { offeringId: NF.eng9 } });
    const drawing = await district.ok(amara, "student.createArtifact", {
      body: { workspaceId: workspace.id, type: "image", title: "My favourite place: Draw it", content: { kind: "bytes", mediaType: "image/png", base64: base64(PNG) } },
    });
    const telling = await district.ok(amara, "student.createArtifact", {
      body: { workspaceId: workspace.id, type: "audio", title: "My favourite place: Tell about it", content: { kind: "bytes", mediaType: "audio/webm", base64: base64(AUDIO["audio/webm"]) } },
    });
    const receipt = await district.ok(amara, "student.submit", {
      params: { assignmentId: assignment.id },
      body: { revisions: [drawing, telling].map((view) => ({ artifactId: view.artifact.id, revisionId: view.head.id })) },
    });

    const rivera = district.tokenFor(NF.rivera);
    const heard = await district.ok(rivera, "teacher.submittedContent", { params: { submissionId: receipt.submissionId, artifactId: telling.artifact.id } });
    expect(heard.item).toMatchObject({ artifactType: "audio", mediaType: "audio/webm" });
    expect(heard.content).toStrictEqual({ kind: "bytes", base64: base64(AUDIO["audio/webm"]) });
    const seen = await district.ok(rivera, "teacher.submittedContent", { params: { submissionId: receipt.submissionId, artifactId: drawing.artifact.id } });
    expect(seen.item).toMatchObject({ artifactType: "image", mediaType: "image/png" });
  });

  it("publishes a recording as audio starter material", async () => {
    const district = await bootDistrict();
    const { assignment } = await pictureResponseIn(district);
    const material = await district.ok(district.tokenFor(NF.rivera), "teacher.publishStarterMaterial", {
      params: { assignmentId: assignment.id },
      body: { title: "Listen to me first", content: { kind: "bytes", mediaType: "audio/mpeg", base64: base64(AUDIO["audio/mpeg"]) } },
    });
    expect(material.type).toBe("audio");
  });
});
