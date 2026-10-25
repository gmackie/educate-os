import { describe, expect, it } from "vitest";
import { SubmissionId } from "@educateos/contracts";
import { canonicalTextBytes, sha256Digest } from "../src/index.ts";
import { DOCS_HOST, essay, O, P, rejectsWith, setup } from "./setup.ts";

const LAB_CSV = "trial,temperature_c,rate\n1,20,0.41\n2,30,0.66\n3,40,0.92\n";
// A tiny synthetic PDF header: binary content goes to R2 whatever its size.
const SOURCE_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0xff]);

describe("W02 acceptance: an essay, lab data and source documents", () => {
  it("are saved, viewed and pinned", async () => {
    const { artifacts, workspaces, bucket } = setup();
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);

    const essayView = await artifacts.createArtifact(P.amara, essay(bio.id, "Draft one."));
    const lab = await artifacts.createArtifact(P.amara, {
      workspaceId: bio.id,
      type: "dataset",
      title: "Enzyme rate lab",
      content: { kind: "text", mediaType: "text/csv", text: LAB_CSV },
      aiAssistance: { level: "none" },
    });
    const pdf = await artifacts.createArtifact(P.amara, {
      workspaceId: bio.id,
      type: "document",
      title: "Source: membrane review",
      content: { kind: "bytes", mediaType: "application/pdf", bytes: SOURCE_PDF },
      aiAssistance: { level: "none" },
    });
    const link = await artifacts.createArtifact(P.amara, {
      workspaceId: bio.id,
      type: "external-ref",
      title: "Source: class reading",
      content: { kind: "external", url: `https://${DOCS_HOST}/d/reading-1` },
      aiAssistance: { level: "none" },
    });

    // Small text is inline; binary content is an R2 object; the link is held as a reference only.
    expect(essayView.head.content.backend).toBe("text");
    expect(lab.head.content.backend).toBe("text");
    expect(pdf.head.content.backend).toBe("r2");
    expect(link.head.content.backend).toBe("external");
    expect(await bucket.head(`sha256/${pdf.head.content.digest.slice(7)}`)).toEqual({ size: SOURCE_PDF.byteLength });
    // Every artifact carries its workspace's classification and the offering's scope.
    expect(lab.artifact).toMatchObject({ classification: "course", scope: { level: "offering", offeringId: O.bioFall }, ownerPrincipalId: P.amara.principal.principalId });

    const second = await artifacts.saveRevision(P.amara, essayView.artifact.id, {
      content: { kind: "text", mediaType: "text/markdown", text: "Draft two, with citations." },
      aiAssistance: { level: "assisted", modelId: "workers-ai/llama-3.3-70b" },
    });
    expect(second.head).toMatchObject({ number: 2, parentRevisionId: essayView.head.id, aiAssistance: { level: "assisted" } });

    expect((await artifacts.readRevision(P.amara, essayView.artifact.id)).content).toEqual({ kind: "text", text: "Draft two, with citations." });
    expect((await artifacts.readRevision(P.amara, essayView.artifact.id, essayView.head.id)).content).toEqual({ kind: "text", text: "Draft one." });
    expect((await artifacts.readRevision(P.amara, lab.artifact.id)).content).toEqual({ kind: "text", text: LAB_CSV });
    expect((await artifacts.readRevision(P.amara, pdf.artifact.id)).content).toEqual({ kind: "bytes", bytes: SOURCE_PDF });
    expect((await artifacts.readRevision(P.amara, link.artifact.id)).content).toEqual({ kind: "external", url: `https://${DOCS_HOST}/d/reading-1` });
    expect((await artifacts.history(P.amara, essayView.artifact.id)).map((r) => r.number)).toEqual([2, 1]);
    expect((await artifacts.listArtifacts(P.amara, bio.id)).map((v) => v.artifact.title).toSorted()).toEqual([
      "Cell membranes essay",
      "Enzyme rate lab",
      "Source: class reading",
      "Source: membrane review",
    ]);

    // A submission pins the exact revisions it captured, idempotently.
    const submissionId = SubmissionId.parse("sub_amara-bio-1");
    const pinned = await artifacts.pin(P.amara, essayView.artifact.id, second.head.id, { kind: "submission", submissionId });
    expect(await artifacts.pin(P.amara, essayView.artifact.id, second.head.id, { kind: "submission", submissionId })).toEqual(pinned);
    await artifacts.pin(P.amara, lab.artifact.id, lab.head.id, { kind: "submission", submissionId });
    await artifacts.pin(P.amara, pdf.artifact.id, pdf.head.id, { kind: "keep" });
  });

  it("gives the same text the same digest whatever line endings or normalization it arrived with", async () => {
    const { artifacts, workspaces } = setup();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const windows = await artifacts.createArtifact(P.amara, essay(personal.id, "﻿café\r\nline two\r\n"));
    const unix = await artifacts.createArtifact(P.amara, essay(personal.id, "café\nline two\n"));
    expect(windows.head.content.digest).toBe(unix.head.content.digest);
    expect(unix.head.content.digest).toBe(await sha256Digest(canonicalTextBytes("café\nline two\n")));
    expect(unix.head.sizeBytes).toBe(canonicalTextBytes("café\nline two\n").byteLength);
  });

  it("rejects a link to an unapproved host, a link with credentials, and content that does not suit the type", async () => {
    const { artifacts, workspaces } = setup();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const link = (url: string) => artifacts.createArtifact(P.amara, {
      workspaceId: personal.id,
      type: "external-ref",
      title: "Reading",
      content: { kind: "external", url },
      aiAssistance: { level: "none" },
    });
    await rejectsWith(link("https://files.attacker.example/x"), "validation-failed");
    await rejectsWith(link(`https://user:pw@${DOCS_HOST}/x`), "validation-failed");
    await rejectsWith(link(`http://${DOCS_HOST}/x`), "validation-failed");
    await rejectsWith(
      artifacts.createArtifact(P.amara, { ...essay(personal.id, "x"), type: "external-ref" }),
      "validation-failed",
    );
    await rejectsWith(
      artifacts.createArtifact(P.amara, { ...essay(personal.id, "x"), content: { kind: "text", mediaType: "application/pdf", text: "x" } }),
      "validation-failed",
    );
  });

  it("only lets a workspace's owner add work to it, and only while the class is open", async () => {
    const { artifacts, workspaces, changeDirectory } = setup();
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    await rejectsWith(artifacts.createArtifact(P.elena, essay(bio.id, "not mine")), "not-found");
    await rejectsWith(artifacts.createArtifact(P.morgan, essay(bio.id, "teacher edit")), "not-found");

    const saved = await artifacts.createArtifact(P.amara, essay(bio.id, "final"));
    await changeDirectory((d) => {
      d.terms.find((t) => t.id === "trm_nf-2026-fall")!.state = "completed";
    });
    await rejectsWith(artifacts.createArtifact(P.amara, essay(bio.id, "late")), "forbidden");
    await rejectsWith(
      artifacts.saveRevision(P.amara, saved.artifact.id, { content: { kind: "text", mediaType: "text/markdown", text: "late edit" }, aiAssistance: { level: "none" } }),
      "forbidden",
    );
    // The work stays readable after the term completes.
    expect((await artifacts.readRevision(P.amara, saved.artifact.id)).content).toEqual({ kind: "text", text: "final" });
  });
});

describe("revisions", () => {
  it("are immutable: saving adds one, and the store refuses any change to a stored one", async () => {
    const { artifacts, workspaces, records } = setup();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const first = await artifacts.createArtifact(P.amara, essay(personal.id, "original"));
    // Changing what a call returned changes nothing stored.
    first.head.sizeBytes = 999;

    await artifacts.saveRevision(P.amara, first.artifact.id, {
      content: { kind: "text", mediaType: "text/markdown", text: "rewritten" },
      aiAssistance: { level: "none" },
    });
    const [, original] = await artifacts.history(P.amara, first.artifact.id);
    expect(original).toMatchObject({ id: first.head.id, number: 1, sizeBytes: "original".length });
    expect((await artifacts.readRevision(P.amara, first.artifact.id, first.head.id)).content).toEqual({ kind: "text", text: "original" });

    // Rewriting history underneath the service is refused by the store itself.
    const { state, version } = await records.load();
    const forged = structuredClone(state);
    forged.revisions[0]!.content = forged.revisions[1]!.content;
    await rejectsWith(records.commit(forged, version), "policy-violation");
    expect((await artifacts.readRevision(P.amara, first.artifact.id, first.head.id)).content).toEqual({ kind: "text", text: "original" });
  });
});
