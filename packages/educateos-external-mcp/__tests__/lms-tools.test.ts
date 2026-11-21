import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { AcademicDirectory } from "@educateos/academics";
import { authorityFor, createDistrictApp, inMemoryDistrictStores } from "@educateos/district-app";
import { DelegableKind, Delegations, SchoolToolRunner } from "@educateos/policy";
import { describeMcpCatalog, lmsSchoolToolDescriptors } from "../src/lms-tools.ts";

const MORGAN = NORTHFIELD.principals.find((p) => p.id === "prn_nf-morgan-lee")!;
const BIO = NORTHFIELD.offerings.find((o) => o.id === "off_nf-bio-fall-p2")!;
const ORIGIN = "https://school.northfield.example";

async function setupLmsTools() {
  const stores = inMemoryDistrictStores(NORTHFIELD);
  const app = await createDistrictApp({
    stores,
    authority: "local",
    verifyRequest: async () => undefined,
    importFetch: async () => { throw new Error("not used"); },
  });
  const directory = new AcademicDirectory({ store: stores.directory, authority: authorityFor("local"), authorizer: app.engine });
  const descriptors = lmsSchoolToolDescriptors(app, stores.directory, directory);
  const runner = new SchoolToolRunner({
    engine: app.engine,
    tools: descriptors.map((d) => d.tool),
    approvals: { store: stores.toolApprovals },
  });
  app.configureMcp({
    status: { enabled: true, endpoint: `${ORIGIN}/mcp`, authMode: "builtin", issuer: ORIGIN, allowDrafts: true, allowedOrigins: [], toolCount: descriptors.length },
    tools: () => describeMcpCatalog(descriptors, true),
    runner: () => runner,
  });

  const delegation = await new Delegations({ store: stores.delegations, policy: app.engine }).issue(
    { principal: { districtId: MORGAN.districtId, principalId: MORGAN.id }, channel: "http" },
    {
      client: { issuer: ORIGIN, clientId: "mcpc_test" },
      ceiling: {
        scope: { level: "offering", districtId: BIO.districtId, schoolId: BIO.schoolId, offeringId: BIO.id },
        actions: ["read", "list", "create", "update", "review", "invoke-tool"],
        kinds: [...DelegableKind.options],
        classifications: ["public", "district-internal", "course", "teacher-only"],
      },
      durationHours: 24,
    },
  );
  const mcpSession = {
    principal: { districtId: MORGAN.districtId, principalId: MORGAN.id, delegationId: delegation.id },
    channel: "mcp-tool" as const,
  };
  return { app, stores, descriptors, runner, mcpSession };
}

describe("full LMS-lite MCP tool catalog", () => {
  it("exposes all core LMS-lite domains while excluding human-only operations", async () => {
    const { descriptors } = await setupLmsTools();
    const names = descriptors.map((d) => d.tool.name);
    expect(names.length).toBeGreaterThanOrEqual(50);
    expect(names).toEqual(expect.arrayContaining([
      "get_my_profile",
      "list_offerings",
      "get_roster",
      "list_modules",
      "create_module",
      "add_course_page",
      "create_activity",
      "list_assignments",
      "list_submissions",
      "add_feedback_comment",
      "propose_grade",
      "get_gradebook",
      "get_classroom_grades",
      "get_roster_sync_status",
      "run_roster_sync",
      "list_quizzes",
      "create_quiz",
      "list_discussions",
      "create_discussion_topic",
      "list_announcements",
      "create_announcement",
      "list_resource_releases",
      "list_class_workspaces",
      "get_class_planner",
      "get_class_guidance",
    ]));
    // Human-only operations must never appear in MCP listings.
    for (const forbidden of [
      "approve_grade",
      "release_quiz_scores",
      "grant_district_admin",
      "create_principal",
      "export_district",
      "issue_delegation",
      "approve_identity_request",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("executes reads and low-risk drafts immediately under allowDrafts, queues consequential writes, and applies them only via HTTP approval", async () => {
    const { app, runner, mcpSession } = await setupLmsTools();

    // 1. Draft module runs immediately when allowDrafts: true
    const createdMod = await runner.invoke(
      mcpSession,
      "create_module",
      { offeringId: BIO.id, title: "Unit 1: Cellular Respiration" },
      { confirmWrites: true, allowDrafts: true },
    );
    expect(createdMod.status).toBe("ok");
    const moduleId = (createdMod as { status: "ok"; value: { id: string } }).value.id;

    // 2. A page can be seen by students as soon as its module is published, so adding one queues
    // even under allowDrafts; a person approves it through the Management UI.
    const addedPage = await runner.invoke(
      mcpSession,
      "add_course_page",
      { offeringId: BIO.id, moduleId, title: "ATP Overview", body: "# ATP\nCells convert glucose to ATP." },
      { confirmWrites: true, allowDrafts: true },
    );
    expect(addedPage.status).toBe("approval-required");
    const pageApproval = addedPage as { status: "approval-required"; approvalId: string; digest: string };
    const pageApplied = await app.callForTool(
      "teacher.approveToolAction",
      { params: { approvalId: pageApproval.approvalId }, body: { digest: pageApproval.digest } },
      { principal: { districtId: MORGAN.districtId, principalId: MORGAN.id }, channel: "http", correlationId: "cor-page", origin: ORIGIN },
    );
    expect(pageApplied.status).toBe("applied");

    // 3. Listing modules returns the newly created module and page
    const listed = await runner.invoke(mcpSession, "list_modules", { offeringId: BIO.id }, { confirmWrites: true, allowDrafts: true });
    expect(listed.status).toBe("ok");
    expect(JSON.stringify((listed as { status: "ok"; value: unknown }).value)).toContain(moduleId);
    expect(JSON.stringify((listed as { status: "ok"; value: unknown }).value)).toContain("ATP Overview");

    // 4. Consequential write (posting a student-visible announcement) ALWAYS queues for human approval even with allowDrafts: true
    const queued = await runner.invoke(
      mcpSession,
      "create_announcement",
      { offeringId: BIO.id, title: "Lab tomorrow", body: "Bring goggles." },
      { confirmWrites: true, allowDrafts: true },
    );
    expect(queued.status).toBe("approval-required");
    const approvalId = (queued as { status: "approval-required"; approvalId: string; digest: string }).approvalId;
    const digest = (queued as { status: "approval-required"; approvalId: string; digest: string }).digest;

    // 5. MCP channel CANNOT approve its own queued write
    const mcpApprove = await runner.approve({ principal: mcpSession.principal, channel: "mcp-tool" }, approvalId, { digest });
    expect(mcpApprove.status).toBe("error");

    // 6. Approving through the Management UI HTTP route applies the announcement
    const httpApprove = await app.callForTool(
      "teacher.approveToolAction",
      { params: { approvalId }, body: { digest } },
      { principal: { districtId: MORGAN.districtId, principalId: MORGAN.id }, channel: "http", correlationId: "cor-approve", origin: ORIGIN },
    );
    expect(httpApprove.status).toBe("applied");

    // 7. Verify the announcement now exists when listed over MCP
    const announcements = await runner.invoke(mcpSession, "list_announcements", { offeringId: BIO.id }, { confirmWrites: true, allowDrafts: true });
    expect(announcements.status).toBe("ok");
    expect((announcements as { status: "ok"; value: { announcement: { title: string } }[] }).value.some((a) => a.announcement.title === "Lab tomorrow")).toBe(true);

    // 8. When allowDrafts: false (strict mode), even draft modules queue for confirmation
    const strictDraft = await runner.invoke(
      mcpSession,
      "create_module",
      { offeringId: BIO.id, title: "Unit 2: Strict Queue" },
      { confirmWrites: true, allowDrafts: false },
    );
    expect(strictDraft.status).toBe("approval-required");
  });
});
