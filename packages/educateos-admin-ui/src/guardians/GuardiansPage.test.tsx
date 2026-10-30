// @vitest-environment jsdom
// The guardians screen against a real district app (seeded as the harness seeds it), so what the
// administrator clicks is decided by the district's own services and policy engine.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { createDistrictApiClient, type DistrictApiClient } from "@educateos/api-client";
import { bootDistrictApp, bootHarness, seedDemo } from "@educateos/harness";
import { renderConsole } from "../testing/renderConsole.tsx";

async function northfield() {
  const entry = (await bootHarness()).find((d) => d.district.districtId === "dst_northfield")!;
  const app = await bootDistrictApp(entry);
  const demo = await seedDemo(entry, app);
  const clientFor = async (subject: string): Promise<DistrictApiClient> => createDistrictApiClient({
    baseUrl: "http://district.harness",
    token: await entry.identity.issueToken(subject),
    fetch: (request) => app.fetch(request),
  });
  return { admin: await clientFor(demo.admin.externalIdentities[0]!.subject), clientFor, student: demo.student };
}

const announcer = () => screen.getByTestId("announcer");

describe("guardians", () => {
  it("invites a guardian, approves their sign-in and confirms them, then suspends and ends the relationship", async () => {
    const { admin, clientFor, student } = await northfield();
    const { user } = renderConsole(admin, "guardians");

    await user.type(await screen.findByLabelText("Student's name"), student.displayName.slice(0, 4));
    await user.click(await screen.findByRole("button", { name: student.displayName }));
    const heading = await screen.findByText(`Guardians of ${student.displayName}`);
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByText(`${student.displayName} has no guardians on EducateOS yet. Invite one below.`)).toBeTruthy();

    // Invite, withholding grades.
    await user.type(screen.getByLabelText("Guardian's name"), "Gina Okafor");
    await user.click(screen.getByRole("checkbox", { name: "Official grades" }));
    await user.click(screen.getByRole("button", { name: "Create invitation link" }));
    const link = await screen.findByText(/\/family\/invitation#invitation=/);
    expect(announcer().textContent).toBe("Invitation link for Gina Okafor ready to copy.");
    expect(screen.getByText(/EducateOS cannot email it yet/)).toBeTruthy();
    const relationships = await screen.findByRole("table", { name: `Guardian relationships of ${student.displayName}` });
    expect(within(relationships).getByText("Waiting for the guardian to sign in")).toBeTruthy();
    expect(within(relationships).getByText(/^Classes, Assignments and due dates, Feedback released to the student, Class announcements$/)).toBeTruthy();
    expect(within(relationships).queryByRole("button", { name: "Confirm Gina Okafor" })).toBeNull();

    // The guardian redeems the link on their own.
    const gina = await clientFor("gina-okafor");
    const token = new URLSearchParams(new URL(link.textContent!).hash.slice(1)).get("invitation")!;
    expect(await gina.call("onboarding.redeemGuardianInvitation", { body: { token } })).toEqual({ outcome: "awaiting-approval" });

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    // The administrator sees which sign-in used the link, not only the name they typed (SCHO-221).
    const pending = await screen.findByRole("region", { name: "Sign-ins to approve" });
    expect(within(pending).getByText("gina-okafor")).toBeTruthy();
    expect(within(pending).getByText(/Used the link on .+, signed in through /)).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Approve Gina Okafor's sign-in" }));
    await waitFor(() => expect(announcer().textContent).toBe("Gina Okafor's sign-in approved."));
    expect(await within(relationships).findByText("Waiting for your confirmation")).toBeTruthy();
    expect(await gina.call("guardian.listChildren")).toEqual([]);

    await user.click(within(relationships).getByRole("button", { name: "Confirm Gina Okafor" }));
    const confirm = await screen.findByRole("alertdialog", { name: `Confirm Gina Okafor as ${student.displayName}'s guardian?` });
    // The dialog lists exactly what the relationship grants: here everything but grades.
    expect(within(confirm).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Classes", "Assignments and due dates", "Feedback released to the student", "Class announcements",
    ]);
    await user.click(within(confirm).getByRole("button", { name: "Confirm guardian" }));
    expect(await within(relationships).findByText("Active")).toBeTruthy();
    expect(screen.getByText("Gina Okafor confirmed as a guardian.", { selector: ":not([data-testid=announcer])" })).toBeTruthy();

    // What Gina's next weekly email would say, without sending it.
    await user.click(within(relationships).getByRole("button", { name: "Preview weekly digest for Gina Okafor" }));
    const digest = await screen.findByRole("dialog", { name: "Gina Okafor's weekly digest" });
    expect(await within(digest).findByText("Subject")).toBeTruthy();
    expect(within(digest).getByLabelText("Digest text").textContent).toContain(student.displayName);
    await user.click(within(digest).getByRole("button", { name: "Close" }));
    expect((await gina.call("guardian.listChildren")).map((c) => c.displayName)).toEqual([student.displayName]);

    await user.click(within(relationships).getByRole("button", { name: "Suspend Gina Okafor" }));
    const suspend = await screen.findByRole("alertdialog", { name: "Suspend Gina Okafor's access?" });
    await user.click(within(suspend).getByRole("radio", { name: "Custody is being reviewed" }));
    await user.click(within(suspend).getByRole("button", { name: "Suspend access" }));
    expect(await within(relationships).findByText("Suspended")).toBeTruthy();
    expect(await gina.call("guardian.listChildren")).toEqual([]);
    const overview = await admin.call("admin.studentGuardians", { params: { studentId: student.id } });
    expect(overview.relationships[0]!.relationship.suspended?.reason).toBe("custody-review");

    await user.click(within(relationships).getByRole("button", { name: "End Gina Okafor's relationship" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: `End Gina Okafor's relationship to ${student.displayName}?` })).getByRole("button", { name: "End relationship" }));
    expect(await within(relationships).findByText("Ended")).toBeTruthy();
    expect(within(relationships).queryByRole("button", { name: /Gina Okafor/ })).toBeNull();
  });

  it("is not offered to someone other than a district administrator, as the district refuses them", async () => {
    const { clientFor, student } = await northfield();
    renderConsole(await clientFor(student.externalIdentities[0]!.subject), "guardians");
    expect(await screen.findByRole("heading", { level: 2, name: "You're not an administrator of this school" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Admin" })).toBeNull();
  });

  it("shows a sign-in the district has not added the ID the district reports for it", async () => {
    const { clientFor } = await northfield();
    renderConsole(await clientFor("nf-not-yet-added"), "guardians");
    expect(await screen.findByRole("heading", { level: 2, name: "You're signed in, but you haven't been added to this school yet" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Your sign-in ID" }).textContent).toContain("nf-not-yet-added");
  });
});
