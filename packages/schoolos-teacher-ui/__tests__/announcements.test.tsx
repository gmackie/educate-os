// SCHO-189: a teacher posts and schedules class announcements, deletes one, and writes the week's
// note to families.
import { screen, waitFor, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp } from "./render.tsx";

const page = `#/classes/${IDS.offering}/announcements`;

describe("class announcements", () => {
  it("posts one now and schedules another, showing which students can see", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, `#/classes/${IDS.offering}/roster`);
    await user.click(await screen.findByRole("link", { name: "Announcements" }));
    await onScreen("Announcements · English 9 · Period 3");
    expect(await screen.findByText("No announcements yet")).toBeTruthy();

    const form = screen.getByRole("form", { name: "New announcement" });
    const post = within(form).getByRole("button", { name: "Post announcement" }) as HTMLButtonElement;
    expect(post.disabled).toBe(true);
    await user.type(within(form).getByRole("textbox", { name: "Title" }), "Library visit");
    await user.type(within(form).getByRole("textbox", { name: /Message/ }), "Friday, period 3.\nBring your card.");
    await user.click(post);
    const posted = await screen.findByRole("article", { name: "Library visit" });
    expect(within(posted).getByText("Published")).toBeTruthy();
    expect(within(posted).getByText(/Bring your card/).textContent).toBe("Friday, period 3.\nBring your card.");
    expect(screen.getByRole("status").textContent).toBe("Announcement posted");
    // The form is cleared for the next one.
    expect((within(form).getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("");

    await user.type(within(form).getByRole("textbox", { name: "Title" }), "Quiz moved");
    await user.type(within(form).getByRole("textbox", { name: /Message/ }), "To Thursday.");
    await user.click(within(form).getByRole("checkbox", { name: "Schedule for later" }));
    const schedule = within(form).getByRole("button", { name: "Schedule announcement" }) as HTMLButtonElement;
    expect(schedule.disabled).toBe(true);
    await user.type(within(form).getByLabelText("Publish at"), "2026-11-02T08:00");
    await user.click(schedule);
    const scheduled = await screen.findByRole("article", { name: "Quiz moved" });
    expect(within(scheduled).getByText("Scheduled")).toBeTruthy();
    expect(district.callsTo("teacher.createAnnouncement")[1]!.input.body).toStrictEqual({
      title: "Quiz moved", body: "To Thursday.", publishAt: new Date("2026-11-02T08:00").toISOString(),
    });
  });

  it("deletes an announcement, and keeps a failed post's text for another try", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, page);
    const form = await screen.findByRole("form", { name: "New announcement" });
    await user.type(within(form).getByRole("textbox", { name: "Title" }), "Wrong room");
    await user.type(within(form).getByRole("textbox", { name: /Message/ }), "Room 12.");
    await user.click(within(form).getByRole("button", { name: "Post announcement" }));
    await user.click(await screen.findByRole("button", { name: "Delete Wrong room" }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Wrong room" })).toBeNull());
    expect(district.callsTo("teacher.deleteAnnouncement")).toHaveLength(1);

    district.fail("teacher.createAnnouncement", { status: 403, body: { code: "forbidden", message: "Only the class's teachers can post or change its announcements." } });
    await user.type(within(form).getByRole("textbox", { name: "Title" }), "Field trip");
    await user.type(within(form).getByRole("textbox", { name: /Message/ }), "Forms due.");
    await user.click(within(form).getByRole("button", { name: "Post announcement" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((within(form).getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("Field trip");
  });

  it("saves and removes the week's note to families", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, page);
    const form = await screen.findByRole("form", { name: "Note to families" });
    await user.type(within(form).getByRole("textbox", { name: "Note for the week" }), "We start Of Mice and Men.");
    await user.click(within(form).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Note saved"));
    expect(district.callsTo("teacher.setWeeklyNote")[0]!.input.body).toStrictEqual({ week: "2026-W44", text: "We start Of Mice and Men." });

    const saved = await screen.findByRole("form", { name: "Note to families" });
    await user.clear(within(saved).getByRole("textbox", { name: "Note for the week" }));
    await user.click(within(saved).getByRole("button", { name: "Remove note" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Note removed"));
  });
});
