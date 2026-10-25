// @vitest-environment jsdom
// SCHO-186: a co-op administrator builds a class by hand; a roster district's records stay the roster's.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";

const form = (name: string) => screen.getByRole("form", { name });

describe("classes and people", () => {
  it("builds a school, term, course, section and people, and enrolls a teacher and a student", async () => {
    const district = fakeDistrict({ authority: "local" });
    const { user } = renderConsole(district.client, "classes-people");
    await screen.findByRole("heading", { level: 2, name: "Manage classes and people" });
    await screen.findByRole("form", { name: "Name your school" });
    expect(screen.queryByText("Some records come from your roster")).toBeNull();

    await user.type(within(form("Name your school")).getByRole("textbox", { name: /School or co-op name/ }), "Maple Co-op");
    await user.type(within(form("Name your school")).getByRole("textbox", { name: /Grades/ }), "K-8");
    await user.click(within(form("Name your school")).getByRole("button", { name: "Add school" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Name your school" })).toBeNull());
    expect(district.calls.find((c) => c.name === "admin.createSchool")!.input).toStrictEqual({ body: { name: "Maple Co-op", gradeBands: ["K-8"] } });

    await user.type(within(form("Add a term")).getByRole("textbox", { name: /Term name/ }), "Fall 2026");
    await user.type(within(form("Add a term")).getByLabelText(/Starts/), "2026-09-01");
    await user.type(within(form("Add a term")).getByLabelText(/Ends/), "2026-12-18");
    await user.click(within(form("Add a term")).getByRole("button", { name: "Add term" }));
    await user.click(await screen.findByRole("button", { name: "Start term: Fall 2026" }));
    await waitFor(() => expect(screen.getByText("In session")).toBeTruthy());

    await user.type(within(form("Add a course")).getByRole("textbox", { name: /Course title/ }), "Nature Studies");
    await user.type(within(form("Add a course")).getByRole("textbox", { name: /Grades/ }), "3-5");
    await user.click(within(form("Add a course")).getByRole("radio", { name: "Science" }));
    await user.click(within(form("Add a course")).getByRole("button", { name: "Add course" }));
    await screen.findByRole("cell", { name: "Nature Studies" });

    const section = await screen.findByRole("form", { name: "Add a section" });
    await user.click(within(section).getByRole("radio", { name: "Nature Studies" }));
    await user.click(within(section).getByRole("radio", { name: "Fall 2026" }));
    await user.type(within(section).getByRole("textbox", { name: /Section name/ }), "Tuesdays");
    await user.click(within(section).getByRole("button", { name: "Add section" }));
    await screen.findByRole("heading", { level: 4, name: "Nature Studies · Tuesdays" });

    for (const [kind, name, subject] of [["Staff (teachers, helpers and administrators)", "Jo Parent", "access-jo"], ["Student", "Sky Learner", "access-sky"]] as const) {
      await user.click(within(form("Add a person")).getByRole("radio", { name: kind }));
      await user.type(within(form("Add a person")).getByRole("textbox", { name: /^Name/ }), name);
      await user.type(within(form("Add a person")).getByRole("textbox", { name: /Sign-in ID/ }), subject);
      await user.click(within(form("Add a person")).getByRole("button", { name: "Add person" }));
      await screen.findByRole("cell", { name });
    }
    expect(district.calls.filter((c) => c.name === "admin.createPrincipal").map((c) => c.input)).toMatchObject([
      { body: { kind: "staff", displayName: "Jo Parent", identity: { issuer: "https://fake.cloudflareaccess.com", subject: "access-jo" } } },
      { body: { kind: "student", displayName: "Sky Learner", identity: { subject: "access-sky" } } },
    ]);

    await user.click(screen.getByRole("button", { name: "People in Nature Studies · Tuesdays" }));
    const enroll = await screen.findByRole("form", { name: "Add someone to Nature Studies · Tuesdays" });
    await user.click(within(enroll).getByRole("radio", { name: /Jo Parent/ }));
    expect((within(enroll).getByRole("radio", { name: "Teacher" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
    await user.click(within(enroll).getByRole("button", { name: "Add to section" }));
    const roster = () => screen.getByRole("table", { name: "People in Nature Studies · Tuesdays" });
    await waitFor(() => within(roster()).getByRole("cell", { name: "Teacher" }));
    const again = screen.getByRole("form", { name: "Add someone to Nature Studies · Tuesdays" });
    await user.click(within(again).getByRole("radio", { name: /Sky Learner/ }));
    await user.click(within(again).getByRole("button", { name: "Add to section" }));
    await waitFor(() => within(roster()).getByRole("cell", { name: "Student" }));

    await user.click(screen.getByRole("button", { name: "Remove Sky Learner from Nature Studies · Tuesdays" }));
    await waitFor(() => expect(within(roster()).queryByRole("cell", { name: "Student" })).toBeNull());
    expect(screen.getByTestId("announcer").textContent).toContain("Their work is kept");
  });

  it("archives a section, which then takes no one new until restored", async () => {
    const district = fakeDistrict({ authority: "local" });
    const { client } = district;
    const school = await client.call("admin.createSchool", { body: { name: "Maple", gradeBands: ["K-8"] } });
    const term = await client.call("admin.createTerm", { body: { name: "Fall", startsOn: "2026-09-01", endsOn: "2026-12-18" } });
    const course = await client.call("admin.createCourse", { body: { title: "Art", subject: "arts", gradeBand: "3" } });
    await client.call("admin.createOffering", { body: { schoolId: school.id, termId: term.id, courseId: course.id, sectionName: "Fridays" } });
    await client.call("admin.createPrincipal", { body: { kind: "student", displayName: "Sky", identity: { issuer: "https://fake.cloudflareaccess.com", subject: "s" } } });

    const { user } = renderConsole(client, "classes-people");
    await user.click(await screen.findByRole("button", { name: "People in Art · Fridays" }));
    expect(await screen.findByRole("form", { name: "Add someone to Art · Fridays" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Archive Art · Fridays" }));
    await screen.findByRole("button", { name: "Restore Art · Fridays" });
    expect(screen.queryByRole("form", { name: "Add someone to Art · Fridays" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Restore Art · Fridays" }));
    expect(await screen.findByRole("form", { name: "Add someone to Art · Fridays" })).toBeTruthy();
  });

  it("asks for a kind before adding someone, then corrects an added student into an administrator (SCHO-212)", async () => {
    const district = fakeDistrict({ authority: "local" });
    const { user } = renderConsole(district.client, "classes-people");
    const add = await screen.findByRole("form", { name: "Add a person" });
    await user.type(within(add).getByRole("textbox", { name: /^Name/ }), "Second Admin");
    await user.type(within(add).getByRole("textbox", { name: /Sign-in ID/ }), "access-second");
    expect((within(add).getByRole("button", { name: "Add person" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(add).getByRole("radio", { name: "Student" }));
    await user.click(within(add).getByRole("button", { name: "Add person" }));
    await screen.findByRole("cell", { name: "Second Admin" });
    // A student cannot be offered administration.
    expect(screen.queryByRole("button", { name: "Make Second Admin an administrator" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Edit Second Admin" }));
    const edit = screen.getByRole("form", { name: "Edit Second Admin" });
    await user.click(within(edit).getByRole("radio", { name: /^Staff/ }));
    await user.type(within(edit).getByRole("textbox", { name: /Email/ }), "second@coop.example");
    await user.click(within(edit).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit Second Admin" })).toBeNull());
    expect(district.calls.find((c) => c.name === "admin.updatePrincipal")!.input).toStrictEqual({
      params: { principalId: expect.any(String) },
      body: { email: "second@coop.example", kind: "staff" },
    });

    await user.click(await screen.findByRole("button", { name: "Make Second Admin an administrator" }));
    await screen.findByRole("button", { name: "Remove Second Admin as administrator" });
    expect(screen.getAllByText("Administrator")).toHaveLength(2);
    expect(screen.getByTestId("announcer").textContent).toContain("now a district administrator");
  });

  it("deactivates and reactivates someone, and shows why the last administrator stays one", async () => {
    const district = fakeDistrict({ authority: "local" });
    await district.client.call("admin.createPrincipal", { body: { kind: "student", displayName: "Sky", identity: { issuer: "https://fake.cloudflareaccess.com", subject: "s" } } });
    const { user } = renderConsole(district.client, "classes-people");
    await user.click(await screen.findByRole("button", { name: "Deactivate Sky" }));
    await user.click(await screen.findByRole("button", { name: "Reactivate Sky" }));
    await screen.findByRole("button", { name: "Deactivate Sky" });
    expect(district.calls.filter((c) => c.name === "admin.setPrincipalStatus").map((c) => (c.input as { body: unknown }).body)).toStrictEqual([
      { status: "inactive" },
      { status: "active" },
    ]);

    await user.click(screen.getByRole("button", { name: "Remove Avery Admin as administrator" }));
    expect(await screen.findByText(/last administrator/)).toBeTruthy();
  });

  it("lists a roster district's records without offering to change them", async () => {
    renderConsole(fakeDistrict().client, "classes-people");
    expect(await screen.findByText("Some records come from your roster")).toBeTruthy();
    expect(screen.getByText(/Courses \(oneroster\)/)).toBeTruthy();
    for (const name of ["Add a term", "Add a course", "Add a person", "Name your school"]) {
      expect(screen.queryByRole("form", { name })).toBeNull();
    }
  });
});
