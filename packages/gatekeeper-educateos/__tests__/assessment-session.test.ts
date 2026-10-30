import { describe, expect, it, vi } from "vitest";
import { AssessmentSessionCore, type AssessmentChange } from "../src/assessment-session.ts";
import { northfieldDistrict, P } from "./district.ts";

function fixture() {
  const blueprint = { id: "blueprint", commitId: "a".repeat(40), sourceDigest: `sha256:${"b".repeat(64)}` };
  const read = vi.fn(async () => ({ status: 200, body: JSON.stringify({ blueprint: { blueprint } }), correlationId: null }));
  const submit = vi.fn(async (_change: AssessmentChange) => {});
  const account = vi.fn(async () => P.amara);
  const observe = vi.fn(async () => {});
  const district = { ...northfieldDistrict().service, gadgetAssessmentRead: read };
  const session = new AssessmentSessionCore("asg_lab", { district, account, observe, submit });
  return { session, read, submit, account, observe, blueprint, district };
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
});
