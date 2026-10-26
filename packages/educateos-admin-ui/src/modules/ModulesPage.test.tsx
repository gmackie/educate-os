// @vitest-environment jsdom
// U03's acceptance journey: an administrator enables three classes and revokes access safely,
// entirely from the console. Each change is previewed before it is applied, applying creates a new
// configuration version, and a roll back is a version of its own.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { CLASSES, classTitle, fakeDistrict, type FakeClass } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";

/** A class's checkbox in the rollout, found once the class names have loaded. */
const classBox = (c: FakeClass) => screen.findByRole("checkbox", { name: new RegExp(`^${classTitle(c)} \\(Fake (High|Middle) School\\): `) });

const desiredOf = (revision: { desired: unknown }) => revision.desired as { rollout: { target: string; offerings: string[] }; modules: Record<string, { state: string }> };

describe("modules and activation", () => {
  it("previews, enables three classes, shows the version, revokes one class after an impact preview, and rolls back", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "modules");

    // Turn the core module on and pick three classes for the pilot.
    const core = await screen.findByRole("group", { name: "Core learning state" });
    await user.click(within(core).getByRole("radio", { name: "On" }));
    for (const c of CLASSES.slice(0, 3)) await user.click(await classBox(c));
    expect(screen.getByText("3 classes selected.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Preview changes" }));

    // The preview: what turns on, what it pulls in, and the people reached in each class.
    const review = await screen.findByRole("region", { name: "Preview: modules for 3 classes" });
    expect(await within(review).findByText(/Core learning turns on, becomes visible to 3 classes/)).toBeTruthy();
    expect(within(review).getByText(/Learning artifacts turns on, needed by Core learning/)).toBeTruthy();
    const impact = within(review).getByRole("table", { name: "People reached in each affected class" });
    expect(within(impact).getAllByRole("row")).toHaveLength(4);
    expect(within(review).getByText("73 students and 4 staff members in total.")).toBeTruthy();
    expect(within(review).getAllByText(/Policy in force at/)).toHaveLength(3);
    // Nothing is applied by previewing.
    expect(district.revisions).toHaveLength(1);

    await user.click(within(review).getByRole("button", { name: "Activate" }));
    expect(await screen.findByText("Modules activated. Version 2 of the configuration is now in force.")).toBeTruthy();
    // The message takes focus, as the review it replaces held it, so it is in view (SCHO-221).
    expect(document.activeElement?.textContent).toContain("Modules activated");
    expect(district.revisions).toHaveLength(2);
    expect(desiredOf(district.revisions[1]!).rollout).toMatchObject({ target: "selected-course-offerings", offerings: CLASSES.slice(0, 3).map((c) => c.offeringId).toSorted() });
    expect(screen.getByRole("status", { hidden: true }).textContent).toContain("Modules activated. A new configuration version is in force.");

    // The new version is in force, with what it changed.
    const history = screen.getByRole("region", { name: "History" });
    const versions = within(history).getAllByRole("listitem");
    expect(within(versions[0]!).getByText("Version 2")).toBeTruthy();
    expect(within(versions[0]!).getByText("In force")).toBeTruthy();
    expect(within(versions[0]!).getByText(/What version 2 changed/)).toBeTruthy();

    // Revoke one class: the impact is previewed first.
    const visible = await screen.findByRole("region", { name: "Classes with modules on" });
    const target = classTitle(CLASSES[1]!);
    await user.click(within(visible).getByRole("button", { name: `Turn off for ${target}` }));
    const revoke = await screen.findByRole("region", { name: `Preview: turn modules off for ${target}` });
    const revokeImpact = await within(revoke).findByRole("table", { name: "People reached in each affected class" });
    const rows = within(revokeImpact).getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByText(target)).toBeTruthy();
    expect(within(rows[1]!).getByText("27")).toBeTruthy();
    expect(within(rows[1]!).getByText(/Loses Core learning/)).toBeTruthy();
    expect(district.revisions).toHaveLength(2);
    await user.click(within(revoke).getByRole("button", { name: "Turn off for this class" }));
    expect(await screen.findByText(`Modules turned off for ${target}. Version 3 of the configuration is now in force.`)).toBeTruthy();
    expect(desiredOf(district.revisions[2]!).rollout.offerings).not.toContain(CLASSES[1]!.offeringId);
    expect(desiredOf(district.revisions[2]!).rollout.offerings).toHaveLength(2);

    // Roll back to version 2, which is itself previewed and becomes version 4.
    await user.click(screen.getByRole("button", { name: "Roll back to version 2" }));
    const rollback = await screen.findByRole("region", { name: "Preview: roll back to version 2" });
    expect(await within(rollback).findByText(/Core learning becomes visible to 1 class/)).toBeTruthy();
    await user.click(within(rollback).getByRole("button", { name: "Roll back" }));
    expect(await screen.findByText("Rolled back to version 2. Version 4 of the configuration is now in force.")).toBeTruthy();
    expect(desiredOf(district.revisions[3]!).rollout).toStrictEqual(desiredOf(district.revisions[1]!).rollout);
    // Every apply was made against the head it was planned on.
    const applies = district.calls.filter((c) => c.name === "admin.applyConfig").map((c) => (c.input as { body: { expectedHeadRevisionId?: string } }).body.expectedHeadRevisionId);
    expect(applies).toStrictEqual(district.revisions.slice(0, 3).map((r) => r.id));
  });

  it("changes nothing when the administrator goes back from a preview", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "modules");
    const core = await screen.findByRole("group", { name: "Core learning state" });
    await user.click(within(core).getByRole("radio", { name: "On" }));
    await user.click(await classBox(CLASSES[3]!));
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    const review = await screen.findByRole("region", { name: /^Preview:/ });
    await within(review).findByText(/Core learning turns on/);
    await user.click(within(review).getByRole("button", { name: "Back without changing anything" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: /^Preview:/ })).toBeNull());
    expect(district.calls.some((c) => c.name === "admin.applyConfig")).toBe(false);
    expect(district.revisions).toHaveLength(1);
  });

  it("refuses to apply a change the district reports as invalid", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "modules");
    // Enable the pilot for one class, then revoke it: no class would be left.
    const core = await screen.findByRole("group", { name: "Core learning state" });
    await user.click(within(core).getByRole("radio", { name: "On" }));
    await user.click(await classBox(CLASSES[0]!));
    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    await user.click(await within(await screen.findByRole("region", { name: /^Preview:/ })).findByRole("button", { name: "Activate" }));
    await screen.findByText("Modules activated. Version 2 of the configuration is now in force.");
    await user.click(await screen.findByRole("button", { name: `Turn off for ${classTitle(CLASSES[0]!)}` }));
    const review = await screen.findByRole("region", { name: /^Preview: turn modules off/ });
    expect(await within(review).findByText("name at least one offering")).toBeTruthy();
    expect((within(review).getByRole("button", { name: "Turn off for this class" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
