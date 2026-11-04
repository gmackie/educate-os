// @vitest-environment jsdom
// SCHO-331: an administrator imports a signed course bundle into the district's course library.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";

const bundleFile = (text: string, name = "1.0.0.json") => new File([text], name, { type: "application/json" });
const BUNDLE = JSON.stringify({ format: "educateos.ocs-bundle.v1", course: { id: "educateos.io/grade-1-reading-foundations", version: "1.0.0" }, packages: [], exports: [] });

describe("the Course library page", () => {
  it("imports a bundle and lists the course, once", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "course-library");
    expect(await screen.findByText("No courses yet. Import a course bundle to offer it to your teachers.")).toBeTruthy();
    const importButton = screen.getByRole("button", { name: "Import course" }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);

    await user.upload(screen.getByLabelText("Course bundle (.json)"), bundleFile(BUNDLE));
    await user.click(screen.getByRole("button", { name: "Import course" }));
    expect(await screen.findByText("Grade 1 Reading Foundations 1.0.0 is in the course library")).toBeTruthy();
    expect(district.calls.find((c) => c.name === "admin.importCourseBundle")?.input).toStrictEqual({ body: JSON.parse(BUNDLE) });
    expect(screen.getByTestId("announcer").textContent).toContain("Teachers can now add it to their classes.");

    const table = await screen.findByRole("table", { name: "Courses in the district's course library" });
    const row = within(table).getByRole("row", { name: /Grade 1 Reading Foundations/ });
    expect(within(row).getAllByRole("cell").slice(1, 4).map((cell) => cell.textContent)).toStrictEqual(["1.0.0", "educateos.ioSigned", "2 units, 6 activities"]);

    // The same version again changes nothing.
    await user.upload(screen.getByLabelText("Course bundle (.json)"), bundleFile(BUNDLE));
    await user.click(screen.getByRole("button", { name: "Import course" }));
    await waitFor(() => expect(district.calls.filter((c) => c.name === "admin.importCourseBundle")).toHaveLength(2));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Courses in the district's course library" })).getAllByRole("row")).toHaveLength(2));
  });

  it("says why a bundle was refused, and imports nothing that is not JSON", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "course-library");
    await user.upload(await screen.findByLabelText("Course bundle (.json)"), bundleFile("not json", "course.json"));
    await user.click(screen.getByRole("button", { name: "Import course" }));
    expect(await screen.findByText("The course was not imported")).toBeTruthy();
    expect(screen.getByText("course.json is not a course bundle: course bundles are JSON files.")).toBeTruthy();
    expect(district.calls.some((c) => c.name === "admin.importCourseBundle")).toBe(false);

    await user.upload(screen.getByLabelText("Course bundle (.json)"), bundleFile(JSON.stringify({ format: "something-else" })));
    await user.click(screen.getByRole("button", { name: "Import course" }));
    expect(await screen.findByText("The bundle is not an OCS course bundle.")).toBeTruthy();
    expect(screen.getByText("No courses yet. Import a course bundle to offer it to your teachers.")).toBeTruthy();
  });
});
