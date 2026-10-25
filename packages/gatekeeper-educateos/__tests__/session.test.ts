import { describe, expect, it, vi } from "vitest";
import type { VerifiedPrincipal } from "@educateos/contracts";
import {
  decisionResult,
  SchoolToolsSessionCore,
  type SchoolChange,
  type SchoolRead,
  type SchoolToolService,
} from "../src/index.ts";
import { BIO, northfieldDistrict, P } from "./district.ts";

/** A connect request from a browser signed in to the district as `who`, if anyone. */
function connectRequest(who?: string): Request {
  return new Request("https://district.example/gatekeeper/educateos/connect", who ? { headers: { "x-test-principal": who } } : {});
}

/** A session for `account`, with the Workshop's log and approval queue recorded. */
function sessionFor(account: VerifiedPrincipal, district = northfieldDistrict(), options: { district?: SchoolToolService } = {}) {
  const observed: SchoolRead[] = [];
  const submitted: SchoolChange[] = [];
  const service = options.district ?? district.service;
  const session = new SchoolToolsSessionCore({
    district: service,
    account: async () => account,
    observe: async (read) => void observed.push(read),
    submit: async (change) => void submitted.push(change),
  });
  // What the Workshop does when a person approves or rejects a submitted change.
  const approve = async (change: SchoolChange) => decisionResult(await service.approveChange(account, change.approvalId));
  const reject = async (change: SchoolChange) => decisionResult(await service.declineChange(account, change.approvalId, "Declined in the Workshop."));
  return { session, observed, submitted, approve, reject, ...district };
}

describe("the EducateOS gatekeeper session", () => {
  it("takes the subject from the account: no tool argument changes who is asking", async () => {
    const { session, audit, ran, observed } = sessionFor(P.amara);

    // Naming another student selects whose work, and Amara may not see Elena's.
    expect(await session.callTool("list_student_work", { offeringId: BIO, studentId: P.elena.principalId }))
      .toMatchObject({ status: "error", code: "not-found" });
    // An identity, role or district in the arguments is not part of any tool's input.
    for (const claim of [{ principalId: P.elena.principalId }, { subject: P.morgan }, { districtId: "dst_riverbend" }, { role: "teacher" }]) {
      expect(await session.callTool("list_student_work", { offeringId: BIO, studentId: P.elena.principalId, ...claim }))
        .toMatchObject({ status: "error", code: "validation-failed" });
    }
    expect(ran).toEqual([]);
    expect(observed).toEqual([]);
    expect(new Set(audit.map((e) => e.principalId))).toEqual(new Set([P.amara.principalId]));

    const own = await session.callTool("list_student_work", { offeringId: BIO, studentId: P.amara.principalId });
    expect(own).toMatchObject({ status: "ok", value: ["art_amara-lab"] });
    expect(ran).toEqual([{ tool: "list_student_work", subject: P.amara }]);
  });

  it("records a read as an observation before returning it, and withholds it if that is refused", async () => {
    const district = northfieldDistrict();
    const { session, observed } = sessionFor(P.amara, district);
    const read = await session.callTool("list_student_work", { offeringId: BIO, studentId: P.amara.principalId });
    expect(observed).toEqual([{ tool: "list_student_work", args: { offeringId: BIO, studentId: P.amara.principalId }, correlationId: (read as { correlationId: string }).correlationId }]);

    const refusing = new SchoolToolsSessionCore({
      district: district.service,
      account: async () => P.amara,
      observe: async () => { throw new Error("restricted workspace"); },
      submit: async () => {},
    });
    await expect(refusing.callTool("list_student_work", { offeringId: BIO, studentId: P.amara.principalId })).rejects.toThrow("restricted workspace");
  });

  it("ignores readOnlyHint: annotated writes are queued as the writes they are, and the hint is not shown", async () => {
    const { session, observed, submitted, artifacts, ran } = sessionFor(P.amara);
    for (const tool of await session.listTools()) expect(Object.keys(tool).toSorted()).toEqual(["description", "inputSchema", "name"]);

    const edit = await session.callTool("edit_artifact", { artifactId: "art_amara-lab", text: "rewritten" });
    expect(edit).toMatchObject({ status: "awaiting-decision" });
    expect(observed).toEqual([]);
    expect(submitted).toMatchObject([{ tool: "edit_artifact", needs: "confirmation" }]);
    expect(artifacts.get("art_amara-lab")!.text).toBe("Amara's lab report");
    expect(ran).toEqual([]);

    // On someone else's work the hint does not make it a read either: it is refused outright.
    expect(await session.callTool("edit_artifact", { artifactId: "art_elena-lab", text: "x" })).toMatchObject({ status: "error", code: "not-found" });
    expect(submitted).toHaveLength(1);
  });

  it("queues every write for a person: nothing runs until the Workshop forwards their decision", async () => {
    const { session, submitted, approve, artifacts, ran } = sessionFor(P.amara);
    await session.callTool("edit_artifact", { artifactId: "art_amara-lab", text: "v2" });
    // The session offers the agent nothing that decides a change.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(session)).toSorted()).toEqual(["callTool", "constructor", "listTools"]);
    expect(ran).toEqual([]);

    expect(await approve(submitted[0]!)).toEqual({ kind: "done" });
    expect(artifacts.get("art_amara-lab")!.text).toBe("v2");
    // A retried approval does not run the change again.
    expect(await approve(submitted[0]!)).toEqual({ kind: "done" });
    expect(ran).toEqual([{ tool: "edit_artifact", subject: P.amara }]);
  });

  it("holds a teacher's agent grade for a teacher's approval, which the teacher gives in the Workshop", async () => {
    const district = northfieldDistrict();
    const teacher = sessionFor(P.morgan, district);
    const outcome = await teacher.session.callTool("record_grade", { offeringId: BIO, studentId: P.amara.principalId, score: 88 });
    expect(outcome).toMatchObject({ status: "awaiting-decision" });
    const [change] = teacher.submitted;
    expect(change).toMatchObject({ tool: "record_grade", needs: "approval" });
    expect(district.ran).toEqual([]);

    // The agent cannot approve its own change: the agent channel decides nothing.
    expect(await district.runner.approve({ principal: P.morgan, channel: "agent" }, change!.approvalId))
      .toMatchObject({ status: "error", error: { code: "forbidden" } });
    // A student's decision is no decision: the request is not even visible to her.
    expect(decisionResult(await district.service.approveChange(P.amara, change!.approvalId))).toMatchObject({ kind: "refused" });
    expect(district.ran).toEqual([]);

    expect(await teacher.approve(change!)).toEqual({ kind: "done" });
    expect(district.ran).toEqual([{ tool: "record_grade", subject: P.morgan }]);
    const decision = district.audit.findLast((e) => e.action === "approve");
    expect(decision).toMatchObject({ principalId: P.morgan.principalId, channel: "http", effect: "allow", ruleId: "grade.official.teacher-direct" });
  });

  it("declines a change the person rejects, and it never runs", async () => {
    const { session, submitted, reject, approve, approvals, ran } = sessionFor(P.amara);
    await session.callTool("edit_artifact", { artifactId: "art_amara-lab", text: "v2" });
    expect(await reject(submitted[0]!)).toEqual({ kind: "done" });
    expect(await approvals.get(submitted[0]!.approvalId)).toMatchObject({ state: "declined", declineReason: "Declined in the Workshop." });
    expect(await approve(submitted[0]!)).toMatchObject({ kind: "refused" });
    expect(ran).toEqual([]);
  });

  it("denies cross-district calls: another district's account, and another district's records", async () => {
    // A Riverbend account against Northfield's district: refused before anything is decided.
    const outsider = sessionFor(P.rbMorgan);
    expect(await outsider.session.callTool("list_student_work", { offeringId: BIO, studentId: P.amara.principalId }))
      .toMatchObject({ status: "error", code: "unauthenticated" });
    expect(await outsider.session.callTool("record_grade", { offeringId: BIO, studentId: P.amara.principalId, score: 1 }))
      .toMatchObject({ status: "error", code: "unauthenticated" });
    expect(outsider.audit).toEqual([]);
    expect(outsider.submitted).toEqual([]);

    // A Northfield account naming a Riverbend class: denied as not found, and audited as cross-district.
    const local = sessionFor(P.morgan);
    expect(await local.session.callTool("list_student_work", { offeringId: "off_rb-bio-a", studentId: P.ines.principalId }))
      .toMatchObject({ status: "error", code: "not-found" });
    expect(await local.session.callTool("record_grade", { offeringId: "off_rb-bio-a", studentId: P.ines.principalId, score: 1 }))
      .toMatchObject({ status: "error", code: "not-found" });
    expect(local.audit.map((e) => e.ruleId)).toContain("precheck.cross-district");
    expect(local.submitted).toEqual([]);
    expect(local.ran).toEqual([]);

    // A Riverbend decision on a Northfield change is refused too.
    await local.session.callTool("record_grade", { offeringId: BIO, studentId: P.amara.principalId, score: 90 });
    expect(await local.service.approveChange(P.rbMorgan, local.submitted[0]!.approvalId)).toMatchObject({ status: "error", error: { code: "unauthenticated" } });
    expect(local.ran).toEqual([]);
  });

  it("verifies the connect request with the district's own sign-in, and refuses another district's principal", async () => {
    const { service } = northfieldDistrict();
    expect(await service.authenticate(connectRequest(P.amara.principalId))).toEqual(P.amara);
    expect(await service.authenticate(connectRequest())).toBeNull();
    expect(await service.authenticate(connectRequest(P.ines.principalId))).toBeNull();
  });

  it("serves the district's pages for a principal of this district only", async () => {
    const { service } = northfieldDistrict();
    const page = new Request("https://district.example/api/teacher/offerings/x/roster", { headers: { "x-test-principal": P.amara.principalId } });
    // The district application decides the rest; the service passes the principal it was given, not the request's sign-in.
    expect(await (await service.serveAs(P.morgan, page)).json()).toEqual({ servedAs: P.morgan, method: "GET", path: "/api/teacher/offerings/x/roster" });
    const outsider = await service.serveAs(P.rbMorgan, page);
    expect(outsider.status).toBe(401);
    expect(await outsider.json()).toMatchObject({ code: "unauthenticated" });
  });

  it("calls nothing for a revoked account", async () => {
    const district = northfieldDistrict();
    const callTool = vi.spyOn(district.service, "callTool");
    const session = new SchoolToolsSessionCore({
      district: district.service,
      account: async () => { throw new Error("This EducateOS account is not connected."); },
      observe: async () => {},
      submit: async () => {},
    });
    await expect(session.callTool("list_student_work", {})).rejects.toThrow("not connected");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("reports a district without an approval queue as unable to take changes", async () => {
    const district = northfieldDistrict();
    const service: SchoolToolService = {
      ...district.service,
      callTool: async () => ({ status: "approval-required", correlationId: "c-1" }),
    };
    const { session, submitted } = sessionFor(P.morgan, district, { district: service });
    expect(await session.callTool("record_grade", {})).toMatchObject({ status: "error", code: "unavailable" });
    expect(submitted).toEqual([]);
  });
});
