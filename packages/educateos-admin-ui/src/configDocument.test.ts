// The console never sends a revision back as it is: it rebuilds the document a revision was
// compiled from and edits that. These tests run the rebuild against a real district app, seeded
// as the harness seeds it, so the district's own compiler and planner judge the result.
import { beforeAll, describe, expect, it } from "vitest";
import { createDistrictApiClient, type DistrictApiClient } from "@educateos/api-client";
import type { OfferingId } from "@educateos/contracts";
import { bootDistrictApp, bootHarness, seedDemo } from "@educateos/harness";
import { documentFromDesired, readDesired, withDistrictPolicies, withModuleState, withRolloutClasses, type DesiredStateView } from "./configDocument.ts";
import { surveyClasses } from "./modules/classSurvey.ts";

let admin: DistrictApiClient;
let head: DesiredStateView;

beforeAll(async () => {
  const entry = (await bootHarness()).find((d) => d.district.districtId === "dst_northfield")!;
  const app = await bootDistrictApp(entry);
  const demo = await seedDemo(entry, app);
  admin = createDistrictApiClient({
    baseUrl: "http://district.harness",
    token: await entry.identity.issueToken(demo.admin.externalIdentities[0]!.subject),
    fetch: (request) => app.fetch(request),
  });
  const config = await admin.call("admin.getConfig");
  head = readDesired(config.head!);
});

const plan = async (desired: DesiredStateView) => {
  const result = await admin.call("admin.planConfig", { body: { document: documentFromDesired(desired) } });
  if (!result.ok) throw new Error(`did not compile: ${JSON.stringify(result.problems)}`);
  return result.plan;
};

describe("rebuilding a revision's document", () => {
  it("compiles back to the same desired state, so an unedited document changes nothing", async () => {
    const unchanged = await plan(head);
    expect(unchanged.diff).toStrictEqual([]);
    expect(unchanged.packs).toStrictEqual([]);
  });

  it("reads a revision stored before the EducateOS rename with the current names (SCHO-232)", async () => {
    const stored = (await admin.call("admin.getConfig")).head!;
    const lti = { state: "disabled", version: "1.0.0", config: {} };
    const legacy = { ...stored, desired: { ...stored.desired, apiVersion: "schoolos.dev/v1alpha1", modules: { ...(stored.desired.modules as object), "schoolos-lti": lti } } }; // rename-educateos: keep
    const read = readDesired(legacy);
    expect(read.modules).toMatchObject({ "educateos-lti": lti });
    expect(read.modules).not.toHaveProperty("schoolos-lti"); // rename-educateos: keep
    expect(documentFromDesired(read).apiVersion).toBe("educateos.io/v1alpha1");
    expect(readDesired({ ...stored, desired: { ...stored.desired, apiVersion: "schoolos.dev/v1alpha1" } })).toStrictEqual({ ...head, apiVersion: "schoolos.dev/v1alpha1" }); // rename-educateos: keep
    expect((await plan(readDesired({ ...stored, desired: { ...stored.desired, apiVersion: "schoolos.dev/v1alpha1" } }))).diff).toStrictEqual([]); // rename-educateos: keep
  });

  it("carries a district policy edit through as exactly that edit", async () => {
    const tightened = await plan(withDistrictPolicies(head, { ...head.policies, aiMonthlyCapCentsPerPrincipal: 100 }));
    expect(tightened.diff).toStrictEqual([{ path: "/policies/aiMonthlyCapCentsPerPrincipal", change: "changed", before: 200, after: 100 }]);
    expect(tightened.approvals).toStrictEqual([]);
  });

  it("asks for a district administrator's approval when the floor is loosened", async () => {
    const loosened = await plan(withDistrictPolicies(head, { ...head.policies, promptsInGatewayLogs: "permitted" }));
    expect(loosened.approvals.map((a) => a.reason)).toContain("policy-loosened");
  });

  it("turns a module off by itself, without touching the classes", async () => {
    const off = await plan(withModuleState(head, "content-studio" as never, "disabled"));
    expect(off.packs.map((p) => [p.capabilityId, p.changes.includes("disabled")])).toContainEqual(["content-studio", true]);
    expect(off.diff.every((d) => d.path.startsWith("/modules/"))).toBe(true);
  });
});

describe("the class survey", () => {
  it("finds every active class with its counts, and which ones see modules now", async () => {
    const classes = await surveyClasses(admin, head);
    expect(classes.length).toBeGreaterThanOrEqual(3);
    // The harness exposes modules to every active class.
    expect(classes.every((c) => c.visibleNow)).toBe(true);
    expect(classes.every((c) => c.students + c.staff > 0)).toBe(true);
  });

  it("names the classes a selected rollout would withdraw from, with the people affected", async () => {
    const classes = await surveyClasses(admin, head);
    const kept = classes.slice(0, 3).map((c) => c.offeringId);
    const pilot = await plan(withRolloutClasses(head, kept));
    const withdrawn = pilot.offerings.filter((o) => o.packsWithdrawn.length > 0).map((o) => o.offeringId);
    expect(withdrawn.toSorted()).toStrictEqual(classes.slice(3).map((c) => c.offeringId).toSorted());
    expect(withdrawn.some((id: OfferingId) => kept.includes(id))).toBe(false);
  });
});
