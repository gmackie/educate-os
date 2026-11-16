// @vitest-environment jsdom
// The learning-guidance opt-in against a real district app (seeded as the harness seeds it), so what
// the administrator saves is decided and recorded by the district's own services and policy engine.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { createDistrictApiClient, type DistrictApiClient } from "@educateos/api-client";
import { bootDistrictApp, bootHarness, seedDemo } from "@educateos/harness";
import { renderConsole } from "../testing/renderConsole.tsx";

/** A Northfield district, with a way to see every request the administrator's console sends. */
async function northfield() {
  const entry = (await bootHarness()).find((d) => d.district.districtId === "dst_northfield")!;
  const app = await bootDistrictApp(entry);
  const demo = await seedDemo(entry, app);
  const sent: { path: string; body: unknown }[] = [];
  const clientFor = async (subject: string, spy = false): Promise<DistrictApiClient> => createDistrictApiClient({
    baseUrl: "http://district.harness",
    token: await entry.identity.issueToken(subject),
    fetch: async (request) => {
      if (spy && request.method === "POST") sent.push({ path: new URL(request.url).pathname, body: await request.clone().json() });
      return app.fetch(request);
    },
  });
  const adminSubject = demo.admin.externalIdentities[0]!.subject;
  return { admin: await clientFor(adminSubject), spied: await clientFor(adminSubject, true), clientFor, student: demo.student, sent };
}

/** Invites a guardian, approves their sign-in, and (unless told not to) confirms them. Returns the relationship's ID. */
async function onboard(north: Awaited<ReturnType<typeof northfield>>, name: string, subject: string, confirm = true) {
  const { admin, clientFor, student } = north;
  const invited = await admin.call("admin.inviteGuardian", { params: { studentId: student.id }, body: { guardianDisplayName: name } });
  const token = new URLSearchParams(new URL(invited.invitationUrl).hash.slice(1)).get("invitation")!;
  await (await clientFor(subject)).call("onboarding.redeemGuardianInvitation", { body: { token } });
  const { pendingSignIns } = await admin.call("admin.studentGuardians", { params: { studentId: student.id } });
  await admin.call("admin.approveIdentityRequest", { params: { requestId: pendingSignIns.find((p) => p.invitationId === invited.invitation.id)!.requestId } });
  if (confirm) await admin.call("admin.confirmGuardian", { params: { relationshipId: invited.relationship.id } });
  return invited.relationship.id;
}

/** Opens the student's guardians in the console and returns the learning-guidance section. */
async function openSection(north: Awaited<ReturnType<typeof northfield>>) {
  const { user } = renderConsole(north.spied, "guardians");
  await user.type(await screen.findByLabelText("Student's name"), north.student.displayName.slice(0, 4));
  await user.click(await screen.findByRole("button", { name: north.student.displayName }));
  const section = await screen.findByRole("region", { name: "Learning guidance (optional)" });
  return { user, section };
}

const announcer = () => screen.getByTestId("announcer");

describe("learning guidance access", () => {
  it("is off by default and says it is separate from what the guardian already reads", async () => {
    const north = await northfield();
    const relationshipId = await onboard(north, "Gina Okafor", "gina-okafor");
    const { section } = await openSection(north);

    expect(within(section).getByText(/off by default and separate from what a guardian can already read/)).toBeTruthy();
    const row = await within(section).findByRole("group", { name: /Gina Okafor/ });
    expect(within(row).getAllByText("Off").length).toBeGreaterThan(0);
    const suggest = within(row).getByRole("checkbox", { name: "Suggest topics" }) as HTMLInputElement;
    const progress = within(row).getByRole("checkbox", { name: "Progress summary" }) as HTMLInputElement;
    expect(suggest.getAttribute("aria-checked") ?? String(suggest.checked)).toMatch(/false/);
    expect(progress.getAttribute("aria-checked") ?? String(progress.checked)).toMatch(/false/);
    expect(within(row).getByText(/A teacher reviews each one before the student sees it\. Never an assignment\./)).toBeTruthy();
    expect(within(row).getByText(/Never work, responses or chats\./)).toBeTruthy();
    expect((within(section).getByRole("button", { name: "Save learning guidance for Gina Okafor" }) as HTMLButtonElement).disabled).toBe(true);
    // An active relationship carries no "not in force" warning.
    expect(within(section).queryByText(/not in force/)).toBeNull();
    // Nothing was granted by looking at it.
    const state = await north.admin.call("admin.guardianGuidance", { params: { studentId: north.student.id } });
    expect(state.relationships.find((r) => r.relationshipId === relationshipId)).toMatchObject({ enabled: false, capabilities: [], revision: 0 });
  });

  it("sends the chosen capabilities with the revision it loaded, then shows the new state and history", async () => {
    const north = await northfield();
    const relationshipId = await onboard(north, "Gina Okafor", "gina-okafor");
    const { user, section } = await openSection(north);

    await user.click(await within(section).findByRole("checkbox", { name: "Suggest topics" }));
    await user.click(within(section).getByRole("checkbox", { name: "Progress summary" }));
    await user.click(within(section).getByRole("button", { name: "Save learning guidance for Gina Okafor" }));

    await waitFor(() => expect(announcer().textContent).toBe("Learning guidance for Gina Okafor: Suggest topics and Progress summary."));
    expect(north.sent.at(-1)).toEqual({ path: `/api/admin/guardian-relationships/${relationshipId}/guidance`, body: { revision: 0, capabilities: ["suggest", "progress"] } });
    expect(await within(section).findByText("Right now: Suggest topics and Progress summary.")).toBeTruthy();
    // The district recorded who turned it on, and the history shows it.
    expect(await within(section).findByText(/Turned on: Suggest topics and Progress summary · .+ · by /)).toBeTruthy();
    const state = await north.admin.call("admin.guardianGuidance", { params: { studentId: north.student.id } });
    expect(state.relationships[0]).toMatchObject({ enabled: true, capabilities: ["suggest", "progress"], revision: 1 });
  });

  it("turns guidance off by sending an empty list, and keeps the history", async () => {
    const north = await northfield();
    const relationshipId = await onboard(north, "Gina Okafor", "gina-okafor");
    await north.admin.call("admin.setGuardianGuidance", { params: { relationshipId }, body: { revision: 0, capabilities: ["suggest"] } });
    const { user, section } = await openSection(north);

    expect(await within(section).findByText("Right now: Suggest topics.")).toBeTruthy();
    await user.click(within(section).getByRole("checkbox", { name: "Suggest topics" }));
    await user.click(within(section).getByRole("button", { name: "Save learning guidance for Gina Okafor" }));

    await waitFor(() => expect(announcer().textContent).toBe("Learning guidance turned off for Gina Okafor."));
    expect(north.sent.at(-1)!.body).toEqual({ revision: 1, capabilities: [] });
    expect(await within(section).findByText("Right now: Off.")).toBeTruthy();
    const history = await within(section).findByRole("list", { name: /Learning guidance history for Gina Okafor/ });
    expect(within(history).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^Turned on: Suggest topics · /),
      expect.stringMatching(/^Turned off: nothing · /),
    ]);
  });

  it("says plainly when someone else changed it first, and reloads on request", async () => {
    const north = await northfield();
    const relationshipId = await onboard(north, "Gina Okafor", "gina-okafor");
    const { user, section } = await openSection(north);
    await within(section).findByRole("group", { name: /Gina Okafor/ });

    // Another administrator turns on the summary after this page loaded.
    await north.admin.call("admin.setGuardianGuidance", { params: { relationshipId }, body: { revision: 0, capabilities: ["progress"] } });
    await user.click(within(section).getByRole("checkbox", { name: "Suggest topics" }));
    await user.click(within(section).getByRole("button", { name: "Save learning guidance for Gina Okafor" }));

    const status = await within(section).findByText("This changed. Reload.");
    expect(status.closest("[role=status]")).toBeTruthy();
    // Nothing of the stale choice was saved.
    expect((await north.admin.call("admin.guardianGuidance", { params: { studentId: north.student.id } })).relationships[0]).toMatchObject({ capabilities: ["progress"], revision: 1 });
    await user.click(within(section).getByRole("button", { name: "Reload" }));
    expect(await within(section).findByText("Right now: Progress summary.")).toBeTruthy();
    expect(within(section).queryByText("This changed. Reload.")).toBeNull();
  });

  it("warns that a choice has no effect until the relationship is in force", async () => {
    const north = await northfield();
    await onboard(north, "Gina Okafor", "gina-okafor", false);
    const { section } = await openSection(north);
    const row = await within(section).findByRole("group", { name: /Gina Okafor/ });
    expect(within(row).getByText(/This relationship is not in force at the moment .* has no effect until it is\./)).toBeTruthy();
  });
});
