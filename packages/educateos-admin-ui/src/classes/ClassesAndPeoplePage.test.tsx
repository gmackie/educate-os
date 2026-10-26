// @vitest-environment jsdom
// SCHO-186: a co-op administrator builds a class by hand; a roster district's records stay the roster's.
// SCHO-221: schools are listed and corrected, terms confirm each step, and lockouts are not offered.
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { fakeDistrict } from "../testing/fakeDistrict.ts";
import { chooseOption, selectTrigger } from "../testing/chooseOption.ts";
import { renderConsole } from "../testing/renderConsole.tsx";

const form = (name: string) => screen.getByRole("form", { name });

describe("classes and people", () => {
  it("builds a school, term, course, section and people, and enrolls a teacher and a student", async () => {
    const district = fakeDistrict({ authority: "local" });
    const { user } = renderConsole(district.client, "classes-people");
    await screen.findByRole("heading", { level: 2, name: "Manage classes and people" });
    expect(screen.queryByText("Some records come from your roster")).toBeNull();
    // Schools have their own section, above the sections that need one (SCHO-221).
    const schools = await screen.findByRole("region", { name: "Schools" });
    expect(within(schools).getByText(/No schools yet/)).toBeTruthy();
    expect(screen.getByText("Add a school, a term and a course to create a section.")).toBeTruthy();

    await user.type(within(form("Add a school")).getByRole("textbox", { name: /School or co-op name/ }), "Maple Co-op");
    await user.type(within(form("Add a school")).getByRole("textbox", { name: /Grades/ }), "K-8");
    await user.click(within(form("Add a school")).getByRole("button", { name: "Add school" }));
    await within(schools).findByRole("cell", { name: "Maple Co-op" });
    expect(district.calls.find((c) => c.name === "admin.createSchool")!.input).toStrictEqual({ body: { name: "Maple Co-op", gradeBands: ["K-8"] } });
    // What changed is shown beside the form that changed it, not only announced.
    expect(within(schools).getByText("Added Maple Co-op.")).toBeTruthy();

    await user.type(within(form("Add a term")).getByRole("textbox", { name: /Term name/ }), "Fall 2026");
    await user.type(within(form("Add a term")).getByLabelText(/Starts/), "2026-09-01");
    await user.type(within(form("Add a term")).getByLabelText(/Ends/), "2026-12-18");
    await user.click(within(form("Add a term")).getByRole("button", { name: "Add term" }));
    const terms = screen.getByRole("region", { name: "Terms" });
    // Dates read in the reader's locale, not as ISO dates.
    expect(await within(terms).findByRole("cell", { name: "Sep 1, 2026 to Dec 18, 2026" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Start term: Fall 2026" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "Start term: Fall 2026?" })).getByRole("button", { name: "Start term" }));
    await waitFor(() => expect(screen.getByText("In session")).toBeTruthy());

    const course = form("Add a course");
    await user.type(within(course).getByRole("textbox", { name: /Course title/ }), "Nature Studies");
    await user.type(within(course).getByRole("textbox", { name: /Grades/ }), "3-5");
    // The subject is a choice to make, with no default.
    expect((within(course).getByRole("button", { name: "Add course" }) as HTMLButtonElement).disabled).toBe(true);
    await chooseOption(user, /Subject/, "Science", course);
    await user.click(within(course).getByRole("button", { name: "Add course" }));
    await screen.findByRole("cell", { name: "Nature Studies" });
    expect(district.calls.find((c) => c.name === "admin.createCourse")!.input).toStrictEqual({ body: { title: "Nature Studies", subject: "science", gradeBand: "3-5" } });

    // The section asks for a school, and each choice with one option starts chosen.
    const section = await screen.findByRole("form", { name: "Add a section" });
    for (const [group, only] of [["School", "Maple Co-op"], ["Course", "Nature Studies"], ["Term", "Fall 2026"]] as const) {
      expect(within(within(section).getByRole("group", { name: group })).getByRole("radio", { name: only }).getAttribute("aria-checked")).toBe("true");
    }
    await user.type(within(section).getByRole("textbox", { name: /Section name/ }), "Tuesdays");
    await user.click(within(section).getByRole("button", { name: "Add section" }));
    await screen.findByRole("heading", { level: 4, name: "Nature Studies · Tuesdays" });
    expect(district.calls.find((c) => c.name === "admin.createOffering")!.input).toMatchObject({ body: { schoolId: expect.stringMatching(/^sch_/), sectionName: "Tuesdays" } });

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
    await user.type(within(enroll).getByRole("textbox", { name: /Find a person/ }), "jo");
    expect(within(enroll).queryByRole("radio", { name: /Sky Learner/ })).toBeNull();
    await user.click(within(enroll).getByRole("radio", { name: /Jo Parent/ }));
    await chooseOption(user, "Role", "Co-teacher", enroll);
    await user.click(within(enroll).getByRole("button", { name: "Add to section" }));
    const roster = () => screen.getByRole("table", { name: "People in Nature Studies · Tuesdays" });
    await waitFor(() => within(roster()).getByRole("cell", { name: "Co-teacher" }));
    const again = screen.getByRole("form", { name: "Add someone to Nature Studies · Tuesdays" });
    await user.click(within(again).getByRole("radio", { name: /Sky Learner/ }));
    expect(within(again).getByText("Sky Learner joins as a student.")).toBeTruthy();
    await user.click(within(again).getByRole("button", { name: "Add to section" }));
    await waitFor(() => within(roster()).getByRole("cell", { name: "Student" }));

    await user.click(screen.getByRole("button", { name: "Remove Sky Learner from Nature Studies · Tuesdays" }));
    await waitFor(() => expect(within(roster()).queryByRole("cell", { name: "Student" })).toBeNull());
    expect(screen.getByTestId("announcer").textContent).toContain("Their work is kept");
  });

  it("corrects a school, a term and a course", async () => {
    const district = fakeDistrict({ authority: "local" });
    const { client } = district;
    await client.call("admin.createSchool", { body: { name: "Maple", gradeBands: ["K-8"] } });
    await client.call("admin.createTerm", { body: { name: "Fall", startsOn: "2026-09-01", endsOn: "2026-12-18" } });
    await client.call("admin.createCourse", { body: { title: "Art", subject: "arts", gradeBand: "3" } });
    const { user } = renderConsole(client, "classes-people");

    await user.click(await screen.findByRole("button", { name: "Edit Maple" }));
    const school = screen.getByRole("form", { name: "Edit a school" });
    await user.clear(within(school).getByRole("textbox", { name: /School or co-op name/ }));
    await user.type(within(school).getByRole("textbox", { name: /School or co-op name/ }), "Maple Co-op");
    await user.click(within(school).getByRole("button", { name: "Save school" }));
    await screen.findByRole("cell", { name: "Maple Co-op" });
    expect(district.calls.find((c) => c.name === "admin.updateSchool")!.input).toMatchObject({ body: { name: "Maple Co-op", gradeBands: ["K-8"] } });

    await user.click(screen.getByRole("button", { name: "Edit Fall" }));
    const term = screen.getByRole("form", { name: "Edit a term" });
    await user.clear(within(term).getByRole("textbox", { name: /Term name/ }));
    await user.type(within(term).getByRole("textbox", { name: /Term name/ }), "Fall 2026");
    await user.click(within(term).getByRole("button", { name: "Save term" }));
    await screen.findByRole("cell", { name: "Fall 2026" });
    expect(district.calls.find((c) => c.name === "admin.updateTerm")!.input).toMatchObject({ body: { name: "Fall 2026", startsOn: "2026-09-01", endsOn: "2026-12-18" } });

    await user.click(screen.getByRole("button", { name: "Edit Art" }));
    const course = screen.getByRole("form", { name: "Edit Art" });
    expect(selectTrigger(/Subject/, course).textContent).toContain("Arts");
    await chooseOption(user, /Subject/, "Social-emotional learning", course);
    await user.click(within(course).getByRole("button", { name: "Save course" }));
    await screen.findByRole("cell", { name: "Social-emotional learning" });
    expect(district.calls.find((c) => c.name === "admin.updateCourse")!.input).toMatchObject({ body: { title: "Art", subject: "social-emotional-learning", gradeBand: "3" } });
  });

  it("confirms each step of a term, so a double click cannot take two", async () => {
    const district = fakeDistrict({ authority: "local" });
    await district.client.call("admin.createTerm", { body: { name: "Fall", startsOn: "2026-09-01", endsOn: "2026-12-18" } });
    const { user } = renderConsole(district.client, "classes-people");
    await user.dblClick(await screen.findByRole("button", { name: "Start term: Fall" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Start term: Fall?" });
    expect(district.calls.some((c) => c.name === "admin.transitionTerm")).toBe(false);
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(district.calls.some((c) => c.name === "admin.transitionTerm")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Start term: Fall" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "Start term: Fall?" })).getByRole("button", { name: "Start term" }));
    await screen.findByRole("button", { name: "Start grading: Fall" });
    expect(district.calls.filter((c) => c.name === "admin.transitionTerm").map((c) => (c.input as { body: unknown }).body)).toStrictEqual([{ to: "active" }]);
  });

  it("finds the person to add by name in a district too large to list", async () => {
    const district = fakeDistrict({ authority: "local" });
    const { client } = district;
    const school = await client.call("admin.createSchool", { body: { name: "Maple", gradeBands: ["K-8"] } });
    const term = await client.call("admin.createTerm", { body: { name: "Fall", startsOn: "2026-09-01", endsOn: "2026-12-18" } });
    const course = await client.call("admin.createCourse", { body: { title: "Art", subject: "arts", gradeBand: "3" } });
    await client.call("admin.createOffering", { body: { schoolId: school.id, termId: term.id, courseId: course.id, sectionName: "Fridays" } });
    for (let n = 1; n <= 12; n++) {
      await client.call("admin.createPrincipal", { body: { kind: "student", displayName: `Learner ${n}`, identity: { issuer: "https://fake.cloudflareaccess.com", subject: `s${n}` } } });
    }
    const { user } = renderConsole(client, "classes-people");
    await user.click(await screen.findByRole("button", { name: "People in Art · Fridays" }));
    const enroll = await screen.findByRole("form", { name: "Add someone to Art · Fridays" });
    // Thirteen people are not listed until a search narrows them.
    expect(within(enroll).queryByRole("radio")).toBeNull();
    expect(within(enroll).getByText(/among the 13 people not in this section/)).toBeTruthy();
    await user.type(within(enroll).getByRole("textbox", { name: /Find a person/ }), "learner");
    expect(within(enroll).getAllByRole("radio")).toHaveLength(8);
    expect(within(enroll).getByText("Showing 8 of 12 matches. Type more of their name to narrow it.")).toBeTruthy();
    await user.type(within(enroll).getByRole("textbox", { name: /Find a person/ }), " 12");
    await user.click(within(enroll).getByRole("radio", { name: /Learner 12/ }));
    await user.click(within(enroll).getByRole("button", { name: "Add to section" }));
    await within(await screen.findByRole("table", { name: "People in Art · Fridays" })).findByRole("cell", { name: "Learner 12" });
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

  it("deactivates and reactivates someone, and never offers to lock an administrator out", async () => {
    const district = fakeDistrict({ authority: "local" });
    await district.client.call("admin.createPrincipal", { body: { kind: "student", displayName: "Sky", identity: { issuer: "https://fake.cloudflareaccess.com", subject: "s" } } });
    const second = await district.client.call("admin.createPrincipal", { body: { kind: "staff", displayName: "Blair", identity: { issuer: "https://fake.cloudflareaccess.com", subject: "b" } } });
    const { user } = renderConsole(district.client, "classes-people");
    await user.click(await screen.findByRole("button", { name: "Deactivate Sky" }));
    await user.click(await screen.findByRole("button", { name: "Reactivate Sky" }));
    await screen.findByRole("button", { name: "Deactivate Sky" });
    expect(district.calls.filter((c) => c.name === "admin.setPrincipalStatus").map((c) => (c.input as { body: unknown }).body)).toStrictEqual([
      { status: "inactive" },
      { status: "active" },
    ]);

    // Avery is signed in and the only administrator: neither is offered on their row (SCHO-221).
    const avery = screen.getByRole("row", { name: /Avery Admin/ });
    expect(within(avery).getByText("You")).toBeTruthy();
    expect(within(avery).queryByRole("button", { name: /Remove Avery Admin as administrator|Deactivate Avery Admin/ })).toBeNull();
    expect(screen.getByText(/You can't remove your own administration or deactivate yourself/)).toBeTruthy();
    expect(screen.getByText(/Avery Admin is the only administrator/)).toBeTruthy();

    // With a second administrator, the second can be removed; Avery, being the caller, still cannot.
    await user.click(screen.getByRole("button", { name: "Make Blair an administrator" }));
    await screen.findByRole("button", { name: "Remove Blair as administrator" });
    expect(screen.getByRole("button", { name: "Deactivate Blair" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove Avery Admin as administrator" })).toBeNull();
    expect(screen.queryByText(/is the only administrator/)).toBeNull();
    expect(second.id).toMatch(/^prn_/);
  });

  it("lists a roster district's records without offering to change them", async () => {
    renderConsole(fakeDistrict().client, "classes-people");
    expect(await screen.findByText("Some records come from your roster")).toBeTruthy();
    expect(screen.getByText(/Courses \(oneroster\)/)).toBeTruthy();
    for (const name of ["Add a school", "Add a term", "Add a course", "Add a person", "Add a section"]) {
      expect(screen.queryByRole("form", { name })).toBeNull();
    }
  });
});
