// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";
import { loosenedSettings } from "./policySettings.ts";

const desiredPolicies = (revision: { desired: unknown }) => (revision.desired as { policies: Record<string, unknown> }).policies;

describe("district policies", () => {
  it("explains every setting in plain language", async () => {
    renderConsole(fakeDistrict().client, "policies");
    for (const name of ["AI spending", "Prompt logging", "Personal conversation privacy", "Teacher observation", "Social-emotional profiling"]) {
      expect(await screen.findByRole("group", { name })).toBeTruthy();
    }
    expect(screen.getByText("Who can read the AI conversations students have in their own personal space.")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Monthly AI cap per person (US dollars)" })).toBeTruthy();
  });

  it("asks for an explicit district-level confirmation before loosening, then previews and needs approval", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "policies");
    const logging = await screen.findByRole("group", { name: "Prompt logging" });
    await user.click(within(logging).getByRole("radio", { name: /^Logged:/ }));
    await user.click(screen.getByRole("button", { name: "Review change" }));

    const confirm = await screen.findByRole("alertdialog", { name: "Loosen district policy?" });
    expect(within(confirm).getByText(/This is a district-level change/)).toBeTruthy();
    expect(within(confirm).getByText("Prompt logging: from Not logged to Logged")).toBeTruthy();
    // Nothing has been planned or applied while the administrator decides.
    expect(district.calls.some((c) => c.name === "admin.planConfig")).toBe(false);
    await user.click(within(confirm).getByRole("button", { name: "Confirm district-level change" }));

    const review = await screen.findByRole("region", { name: "Preview: district policy change" });
    const apply = await within(review).findByRole("button", { name: "Apply policy" }) as HTMLButtonElement;
    expect(within(review).getByRole("heading", { name: "Needs a district administrator's approval" })).toBeTruthy();
    expect(apply.disabled).toBe(true);
    await user.click(within(review).getByRole("checkbox", { name: /I approve the items listed above/ }));
    await waitFor(() => expect(apply.disabled).toBe(false));
    await user.click(apply);

    expect(await screen.findByText("The district policy was updated.")).toBeTruthy();
    expect(desiredPolicies(district.revisions.at(-1)!).promptsInGatewayLogs).toBe("permitted");
    const applied = district.calls.find((c) => c.name === "admin.applyConfig")!;
    expect((applied.input as { body: { acknowledgeApprovals: boolean } }).body.acknowledgeApprovals).toBe(true);
  });

  it("does not apply a loosening the administrator cancels", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "policies");
    const cap = await screen.findByRole("textbox", { name: "Monthly AI cap per person (US dollars)" });
    await user.clear(cap);
    await user.type(cap, "9.00");
    await user.click(screen.getByRole("button", { name: "Review change" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Monthly AI cap per person: from $2.00 to $9.00")).toBeTruthy();
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(district.calls.some((c) => c.name === "admin.planConfig" || c.name === "admin.applyConfig")).toBe(false);
  });

  it("goes straight to the preview when the change only tightens", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "policies");
    const cap = await screen.findByRole("textbox", { name: "Monthly AI cap per person (US dollars)" });
    await user.clear(cap);
    await user.type(cap, "1.00");
    await user.click(screen.getByRole("button", { name: "Review change" }));
    expect(await screen.findByRole("region", { name: "Preview: district policy change" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("loosenedSettings", () => {
  const strict = {
    aiSpending: "disabled",
    promptsInGatewayLogs: "prohibited",
    studentPersonalConversations: "private",
    teacherObservation: "assigned-work-only",
    automatedSelProfiling: "prohibited",
    aiMonthlyCapCentsPerPrincipal: 200,
  } as const;

  it("finds each setting made less strict, and none made stricter", () => {
    const loose = {
      aiSpending: "capped",
      promptsInGatewayLogs: "permitted",
      studentPersonalConversations: "shared-by-student",
      teacherObservation: "assigned-work-and-shared-conversations",
      automatedSelProfiling: "permitted-with-review",
      aiMonthlyCapCentsPerPrincipal: 201,
    } as const;
    expect(loosenedSettings(strict, loose).map((s) => s.key).toSorted()).toStrictEqual(Object.keys(strict).toSorted());
    expect(loosenedSettings(loose, strict)).toStrictEqual([]);
  });
});
