// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/dom";
import { DistrictApiError, type DistrictApiClient } from "@educateos/api-client";
import { STUDENT_NAMES, fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";

describe("the class list", () => {
  it("lists every class with its school, teachers and student count, never a student's name", async () => {
    const district = fakeDistrict();
    const { container } = renderConsole(district.client, "classes");
    const table = await screen.findByRole("table", { name: "Every class in the district" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toStrictEqual([
      "Art 6 · Section D", "Biology · Section A", "English 9 · Section B", "Math 7 · Section C",
    ]);
    const english = within(table).getByRole("row", { name: /English 9/ });
    expect(within(english).getAllByRole("cell").map((cell) => cell.textContent)).toStrictEqual(["English 9 · Section B", "fk-high", "fk-2026-fall", "Sam Rivera, Wen Chen", "27"]);
    expect(screen.getByText("4 classes")).toBeTruthy();
    for (const name of STUDENT_NAMES) expect(container.textContent).not.toContain(name);
    expect(district.calls.map((c) => c.name)).toContain("admin.listOfferings");
    expect(district.calls.some((c) => c.name === "teacher.roster")).toBe(false);
  });

  it("narrows to the classes a search matches, by teacher or school", async () => {
    const { user } = renderConsole(fakeDistrict().client, "classes");
    const search = await screen.findByRole("textbox", { name: "Find a class" });
    await user.type(search, "chen");
    const table = screen.getByRole("table", { name: "Every class in the district" });
    expect(within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toStrictEqual(["English 9 · Section B"]);
    expect(screen.getByText("1 class of 4 match")).toBeTruthy();
    await user.clear(search);
    await user.type(search, "nowhere");
    expect(screen.getByText("No class matches “nowhere”.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says why the list could not load, and loads it again on Try again", async () => {
    const district = fakeDistrict();
    let failing = true;
    const client: DistrictApiClient = {
      call: ((name: never, ...args: never[]) => {
        if (name === "admin.listOfferings" && failing) {
          failing = false;
          return Promise.reject(new DistrictApiError(403, { code: "forbidden", message: "Only a district administrator can do this.", correlationId: "req-7" }));
        }
        return (district.client.call as (...a: unknown[]) => Promise<unknown>)(name, ...args);
      }) as DistrictApiClient["call"],
    };
    const { user } = renderConsole(client, "classes");
    expect(await screen.findByText("Could not load the district's classes")).toBeTruthy();
    expect(screen.getByText("Only a district administrator can do this. (reference req-7)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Every class in the district" })).toBeTruthy();
  });
});
