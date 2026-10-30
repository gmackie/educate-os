import { describe, expect, it, vi } from "vitest";
import { AssessmentSessionCore, type AssessmentChange, type AssessmentCheckpointChange } from "../src/assessment-session.ts";
import type { GadgetSourceCheckpoint } from "@gadgets/workshop-shared/gatekeeper";
import { northfieldDistrict, P } from "./district.ts";

function fixture() {
  const blueprint = { id: "blueprint", commitId: "a".repeat(40), sourceDigest: `sha256:${"b".repeat(64)}` };
  const read = vi.fn(async () => ({ status: 200, body: JSON.stringify({ blueprint: { blueprint } }), correlationId: null }));
  const submit = vi.fn(async (_change: AssessmentChange) => {});
  const account = vi.fn(async () => P.amara);
  const observe = vi.fn(async () => {});
  const source: GadgetSourceCheckpoint = {
    format: "workshop.gadget-source.v1", policy: "educateos-source-v1", workspaceId: "workspace", gadgetId: 1,
    commitId: "c".repeat(40), sourceDigest: `sha256:${"d".repeat(64)}`,
    blueprint: { id: blueprint.id, commitId: blueprint.commitId }, files: [["main.ts", "export default {};"]],
  };
  const checkpoint = vi.fn(async () => source);
  const submitCheckpoint = vi.fn(async (_change: AssessmentCheckpointChange) => {});
  const writeCheckpoint = vi.fn(async () => ({ status: 201, body: "{}", correlationId: null }));
  const district = { ...northfieldDistrict().service, gadgetAssessmentRead: read, gadgetAssessmentSubmitCheckpoint: writeCheckpoint };
  const session = new AssessmentSessionCore("asg_lab", { district, account, observe, submit, checkpoint, submitCheckpoint });
  return { session, read, submit, account, observe, blueprint, district, checkpoint, submitCheckpoint, writeCheckpoint, source };
}

describe("assignment-scoped assessment capability", () => {
  it("captures the trusted release and queues owned revision references without performing a write", async () => {
    const f = fixture();
    const revisions = [{ artifactId: "art_lab", revisionId: "rev_one" }];
    await f.session.submit(revisions);
    revisions[0]!.revisionId = "rev_changed";
    expect(f.read).toHaveBeenCalledWith(P.amara, "asg_lab");
    expect(f.submit).toHaveBeenCalledWith({ assignmentId: "asg_lab", blueprint: f.blueprint, revisions: [{ artifactId: "art_lab", revisionId: "rev_one" }] });
    expect(f.observe).not.toHaveBeenCalled();
  });

  it("rejects injected authority and refuses unavailable or revoked accounts", async () => {
    const f = fixture();
    await expect(f.session.submit([{ artifactId: "art_lab", revisionId: "rev_one", role: "teacher" }])).rejects.toThrow();
    expect(f.submit).not.toHaveBeenCalled();
    f.account.mockRejectedValue(new Error("Account revoked"));
    await expect(f.session.read()).rejects.toThrow("revoked");
    delete (f.district as Partial<typeof f.district>).gadgetAssessmentRead;
    await expect(f.session.read()).rejects.toThrow("unavailable");
  });

  it("records observations and rechecks current policy for every call", async () => {
    const f = fixture();
    await f.session.read();
    expect(f.observe).toHaveBeenCalledOnce();
    f.read.mockResolvedValue({ status: 403, body: "private diagnostic", correlationId: null });
    await expect(f.session.read()).rejects.toThrow("Assessment access refused (403)");
    await expect(f.session.submit([{ artifactId: "art_lab", revisionId: "rev_one" }])).rejects.toThrow("403");
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("previews trusted source without sending it to the district, then queues the exact frozen snapshot", async () => {
    const f = fixture();
    await expect(f.session.submitCurrentGadget("missing")).rejects.toThrow("Preview");
    const preview = JSON.parse(await f.session.previewCurrentGadget());
    expect(preview).toMatchObject({ assignmentId: "asg_lab", blueprint: f.blueprint, checkpoint: f.source });
    expect(f.checkpoint).toHaveBeenCalledWith();
    expect(f.observe).toHaveBeenCalledOnce();
    expect(f.writeCheckpoint).not.toHaveBeenCalled();
    expect(f.submitCheckpoint).not.toHaveBeenCalled();
    f.source.files[0]![1] = "changed after preview";
    await f.session.submitCurrentGadget(preview.requestId);
    expect(f.submitCheckpoint).toHaveBeenCalledExactlyOnceWith(preview);
    expect(f.writeCheckpoint).not.toHaveBeenCalled();
    await expect(f.session.submitCurrentGadget("missing")).rejects.toThrow("Preview");
  });

  it("withholds previews and source requests when assignment access or observation fails", async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce({ status: 403, body: "private diagnostic", correlationId: null });
    await expect(f.session.previewCurrentGadget()).rejects.toThrow("403");
    expect(f.checkpoint).not.toHaveBeenCalled();
    f.observe.mockRejectedValueOnce(new Error("Observation denied"));
    await expect(f.session.previewCurrentGadget()).rejects.toThrow("Observation denied");
    await expect(f.session.submitCurrentGadget("missing")).rejects.toThrow("Preview");
    expect(f.submitCheckpoint).not.toHaveBeenCalled();
  });

  it("refuses unavailable export and a Gadget based on another release", async () => {
    const f = fixture();
    f.source.blueprint.commitId = "e".repeat(40);
    await expect(f.session.previewCurrentGadget()).rejects.toThrow("reviewed Blueprint release");
    expect(f.observe).not.toHaveBeenCalled();
    delete (f.district as Partial<typeof f.district>).gadgetAssessmentSubmitCheckpoint;
    await expect(f.session.previewCurrentGadget()).rejects.toThrow("unavailable");
    expect(f.submitCheckpoint).not.toHaveBeenCalled();
  });

  it("rechecks current account and assignment access before queueing the preview", async () => {
    const f = fixture();
    const preview = JSON.parse(await f.session.previewCurrentGadget());
    f.account.mockRejectedValueOnce(new Error("Account revoked"));
    await expect(f.session.submitCurrentGadget(preview.requestId)).rejects.toThrow("revoked");
    f.read.mockResolvedValueOnce({ status: 200, body: JSON.stringify({ blueprint: { blueprint: { ...f.blueprint, commitId: "f".repeat(40) } } }), correlationId: null });
    await expect(f.session.submitCurrentGadget(preview.requestId)).rejects.toThrow("release changed");
    expect(f.submitCheckpoint).not.toHaveBeenCalled();
  });

  it("binds submission to the displayed preview ID and refuses a replaced or failed refresh", async () => {
    const f = fixture();
    const first = JSON.parse(await f.session.previewCurrentGadget());
    const second = JSON.parse(await f.session.previewCurrentGadget());
    await expect(f.session.submitCurrentGadget(first.requestId)).rejects.toThrow("Preview");
    expect(f.submitCheckpoint).not.toHaveBeenCalled();
    f.checkpoint.mockRejectedValueOnce(new Error("Source export refused"));
    await expect(f.session.previewCurrentGadget()).rejects.toThrow("Source export refused");
    await expect(f.session.submitCurrentGadget(second.requestId)).rejects.toThrow("Preview");
  });

  it("queues a displayed preview only once when the student double-clicks", async () => {
    const f = fixture();
    const preview = JSON.parse(await f.session.previewCurrentGadget());
    const results = await Promise.allSettled([
      f.session.submitCurrentGadget(preview.requestId),
      f.session.submitCurrentGadget(preview.requestId),
    ]);
    expect(results.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    expect(f.submitCheckpoint).toHaveBeenCalledExactlyOnceWith(preview);
  });
});
