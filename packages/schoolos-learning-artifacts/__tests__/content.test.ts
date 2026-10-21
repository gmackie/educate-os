import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseBackend, ContentDigest, INLINE_TEXT_LIMIT_BYTES, MediaType } from "../src/index.ts";
import { DOCS_HOST, O, P, rejectsWith, setup } from "./setup.ts";

const csv = MediaType.parse("text/csv");
const png = MediaType.parse("image/png");

describe("chooseBackend", () => {
  it("keeps small text inline and sends large text, binaries and recordings to R2", () => {
    expect(chooseBackend({ type: "document", mediaType: csv, sizeBytes: INLINE_TEXT_LIMIT_BYTES })).toBe("text");
    expect(chooseBackend({ type: "document", mediaType: csv, sizeBytes: INLINE_TEXT_LIMIT_BYTES + 1 })).toBe("r2");
    expect(chooseBackend({ type: "dataset", mediaType: png, sizeBytes: 10 })).toBe("r2");
    // A recording or picture is never inline, even with a text media type such as an SVG sent as text.
    expect(chooseBackend({ type: "image", mediaType: MediaType.parse("text/plain"), sizeBytes: 10 })).toBe("r2");
    expect(chooseBackend({ type: "external-ref", mediaType: csv, sizeBytes: 10 })).toBe("external");
  });

  it("sends a saved essay over the inline limit to R2 and reads it back as text", async () => {
    const { artifacts, workspaces } = setup();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const long = "x".repeat(INLINE_TEXT_LIMIT_BYTES + 1);
    const saved = await artifacts.createArtifact(P.amara, {
      workspaceId: personal.id,
      type: "document",
      title: "Long essay",
      content: { kind: "text", mediaType: "text/plain", text: long },
      aiAssistance: { level: "none" },
    });
    expect(saved.head.content.backend).toBe("r2");
    expect((await artifacts.readRevision(P.amara, saved.artifact.id)).content).toEqual({ kind: "text", text: long });
  });
});

describe("digest verification", () => {
  it("refuses to serve or export an R2 object whose bytes were tampered with", async () => {
    const { artifacts, workspaces, bucket } = setup();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const photo = await artifacts.createArtifact(P.amara, {
      workspaceId: personal.id,
      type: "image",
      title: "Leaf under microscope",
      content: { kind: "bytes", mediaType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
      aiAssistance: { level: "none" },
    });
    expect(photo.head.content.backend).toBe("r2");
    // Someone with bucket access swaps the object, bypassing the checksum R2 enforces on upload.
    await bucket.put(photo.head.content.key, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));

    await rejectsWith(artifacts.readRevision(P.amara, photo.artifact.id), "unavailable");
    await rejectsWith(artifacts.exportArtifact(P.amara, photo.artifact.id), "unavailable");
  });

  it("refuses inline text that was changed in its table", async () => {
    const { artifacts, workspaces, text } = setup();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const note = await artifacts.createArtifact(P.amara, {
      workspaceId: personal.id,
      type: "document",
      title: "Note",
      content: { kind: "text", mediaType: "text/plain", text: "the real note" },
      aiAssistance: { level: "none" },
    });
    await text.put(note.head.content.key, "a forged note");
    await rejectsWith(artifacts.readRevision(P.amara, note.artifact.id), "unavailable");
  });
});

describe("an external reference", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is never fetched or treated as content SchoolOS holds", async () => {
    const fetchSpy = vi.fn(async () => new Response("remote content"));
    vi.stubGlobal("fetch", fetchSpy);
    const { artifacts, workspaces, bucket, text } = setup();
    const getObject = vi.spyOn(bucket, "get");
    const putObject = vi.spyOn(bucket, "put");
    const getText = vi.spyOn(text, "get");
    const putText = vi.spyOn(text, "put");
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    const snapshotDigest = ContentDigest.parse(`sha256:${"a".repeat(64)}`);

    const link = await artifacts.createArtifact(P.amara, {
      workspaceId: bio.id,
      type: "external-ref",
      title: "Lab write-up in Docs",
      content: { kind: "external", url: `https://${DOCS_HOST}/d/lab-1`, snapshotDigest },
      aiAssistance: { level: "none" },
    });
    const read = await artifacts.readRevision(P.amara, link.artifact.id);
    const exported = await artifacts.exportArtifact(P.amara, link.artifact.id);

    expect(read.content).toEqual({ kind: "external", url: `https://${DOCS_HOST}/d/lab-1`, snapshotDigest });
    expect(exported.bytes).toBeUndefined();
    expect(exported.manifest.revision.content).toMatchObject({ backend: "external", key: `https://${DOCS_HOST}/d/lab-1`, snapshotDigest });
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of [getObject, putObject, getText, putText]) expect(spy).not.toHaveBeenCalled();

    // The revision's digest commits to the reference and its snapshot, so a different snapshot is a different digest.
    const relinked = await artifacts.saveRevision(P.amara, link.artifact.id, {
      content: { kind: "external", url: `https://${DOCS_HOST}/d/lab-1` },
      aiAssistance: { level: "none" },
    });
    expect(relinked.head.content.digest).not.toBe(link.head.content.digest);
  });
});
