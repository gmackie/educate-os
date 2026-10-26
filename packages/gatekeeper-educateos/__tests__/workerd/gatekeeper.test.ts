// The Worker end to end in workerd: an account is bound to whoever the district's own sign-in says
// followed the connect link, and its facet acts as that principal whatever the agent sends.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BIO, P } from "../district.ts";
import { completions, district } from "./worker.ts";

const hooks = () => env.TEST_HOOKS.getByName("hooks");

/** Starts a connect flow and follows its link, signed in to the district as `who`. */
async function connect(who: string | undefined) {
  const url = await hooks().startConnect();
  const response = await hooks().follow(url, "POST", who);
  return { accountObjectId: new URL(url).pathname.split("/").at(-2)!, url, response };
}

describe("the EducateOS gatekeeper Worker", () => {
  it("binds an account to the principal the district verifies, once", async () => {
    const before = completions.count;
    const url = await hooks().startConnect();
    expect(url).toMatch(/^https:\/\/district\.example\/gatekeeper\/educateos\/connect\/[0-9a-f]{64}\/[0-9a-f]{64}$/);

    // Opening the link changes nothing; it asks the person to confirm.
    expect((await hooks().follow(url, "GET")).body).toContain("Connect your school account");
    // Not signed in to the district: refused, and the link still works.
    expect((await hooks().follow(url, "POST")).status).toBe(401);
    // Signed in: the Workshop is handed the account, and the page delivers the handoff.
    expect((await hooks().follow(url, "POST", P.amara.principalId)).body).toContain("/connect/handoff#");
    expect(completions.count).toBe(before + 1);
    // The link is spent.
    expect((await hooks().follow(url, "POST", P.morgan.principalId)).body).toContain("This link has expired");
    expect(completions.count).toBe(before + 1);
  });

  it("refuses a principal from another district at connect", async () => {
    const { response } = await connect(P.ines.principalId);
    expect(response.status).toBe(401);
  });

  it("acts as the connected principal: arguments naming someone else change nothing", async () => {
    const { accountObjectId } = await connect(P.amara.principalId);
    const elena = await hooks().callTool(accountObjectId, "list_student_work", { offeringId: BIO, studentId: P.elena.principalId });
    expect(elena.result).toMatchObject({ status: "error", code: "not-found" });
    const claimed = await hooks().callTool(accountObjectId, "list_student_work", { offeringId: BIO, studentId: P.elena.principalId, principalId: P.elena.principalId });
    expect(claimed.result).toMatchObject({ status: "error", code: "validation-failed" });

    const own = await hooks().callTool(accountObjectId, "list_student_work", { offeringId: BIO, studentId: P.amara.principalId });
    expect(own).toMatchObject({ result: { status: "ok", value: ["art_amara-lab"] }, observations: ["Read school records (list_student_work)"], actions: [] });
    expect(district.audit.findLast((e) => e.action === "list")).toMatchObject({ principalId: P.amara.principalId, channel: "agent" });
  });

  it("queues an annotated read-only write as a change no rule can auto-approve, and applies it on a person's approval", async () => {
    const { accountObjectId } = await connect(P.amara.principalId);
    expect(await hooks().autoApprovableKinds(accountObjectId)).toEqual([]);

    const edit = await hooks().callTool(accountObjectId, "edit_artifact", { artifactId: "art_amara-lab", text: "from the Workshop" });
    expect(edit).toMatchObject({
      result: { status: "awaiting-decision" },
      observations: [],
      actions: [{ title: "Change school records (edit_artifact)", autoApprovable: false }],
    });
    expect(district.artifacts.get("art_amara-lab")!.text).not.toBe("from the Workshop");

    expect(await hooks().apply(accountObjectId, edit.actions[0]!.id)).toBeNull();
    expect(district.artifacts.get("art_amara-lab")!.text).toBe("from the Workshop");
  });

  it("applies a teacher's agent grade only once the teacher approves it", async () => {
    const teacher = await connect(P.morgan.principalId);
    const grade = await hooks().callTool(teacher.accountObjectId, "record_grade", { offeringId: BIO, studentId: P.amara.principalId, score: 77 });
    expect(grade.result).toMatchObject({ status: "awaiting-decision" });
    const graded = district.ran.filter((r) => r.tool === "record_grade").length;
    expect(await hooks().apply(teacher.accountObjectId, grade.actions[0]!.id)).toBeNull();
    expect(district.ran.filter((r) => r.tool === "record_grade")).toHaveLength(graded + 1);
  });

  it("stops acting for an account once it is revoked", async () => {
    const { accountObjectId } = await connect(P.amara.principalId);
    await hooks().revoke(accountObjectId);
    expect(await hooks().callToolFailure(accountObjectId, "list_student_work", { offeringId: BIO, studentId: P.amara.principalId }))
      .toContain("not connected");
  });

  it("serves the School app's requests to the district's API as the connected person, and nothing else", async () => {
    const { accountObjectId } = await connect(P.morgan.principalId);
    const page = await hooks().schoolAppRequest(accountObjectId, "GET", "/api/teacher/offerings/x/roster", null);
    expect(page.title).toBe("School");
    // The bundle itself is built separately and stubbed here (vitest.worker.config.ts).
    expect(page.html).not.toBe("");
    expect(page.reply?.status).toBe(200);
    expect(JSON.parse(page.reply!.body)).toStrictEqual({ servedAs: P.morgan, method: "GET", path: "/api/teacher/offerings/x/roster" });

    for (const path of ["/connect/x", "/api/../admin", "https://elsewhere.example/api/me", "/api/me#x"]) {
      expect((await hooks().schoolAppRequest(accountObjectId, "GET", path, null)).refused).toContain("only the district's API");
    }
    expect((await hooks().schoolAppRequest(accountObjectId, "GET", "/api/me", "{}")).refused).toContain("not one the district's API takes");
    expect((await hooks().schoolAppRequest(accountObjectId, "POST", "/api/me", null)).refused).toContain("not one the district's API takes");
  });

  it("stops serving an open School app once its account is revoked", async () => {
    const { accountObjectId } = await connect(P.amara.principalId);
    await hooks().revoke(accountObjectId);
    expect((await hooks().schoolAppRequest(accountObjectId, "GET", "/api/me", null)).refused).toContain("not connected");
  });

  it("admits no collaborator to a workspace that reads school records", async () => {
    const { accountObjectId } = await connect(P.amara.principalId);
    expect(await hooks().addObserver(accountObjectId)).toMatch(/cannot be shared/);
  });
});
