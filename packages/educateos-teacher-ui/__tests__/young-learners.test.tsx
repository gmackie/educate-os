// SCHO-323: a teacher creates the K-2 templates, and hears a student's recording in review.
import { screen, within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import { buildActivity, emptyActivityForm, type ActivityContext } from "../src/activities/activityForm.ts";
import { SubmittedFile } from "../src/submissions/SubmittedFile.tsx";
import { fakeDistrict, IDS } from "./fakeDistrict.ts";
import { onScreen, renderApp } from "./render.tsx";

const CONTEXT: ActivityContext = { subject: "science", gradeBand: "K-2", goals: [], releases: [] };

describe("creating a picture response", () => {
  it("sends the picture-response template, and previews what each step asks for", async () => {
    const district = fakeDistrict();
    const user = await renderApp(district.client, `#/classes/${IDS.offering}/create`);
    await onScreen(/^Create activity/);
    await user.click(screen.getByRole("radio", { name: /Picture response/ }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Who lives in the pond?");
    await user.type(screen.getByRole("textbox", { name: "Overview for students" }), "We are learning about pond animals.");
    await user.type(screen.getByRole("textbox", { name: "What students look at or listen to first" }), "Look at the pond.");
    await user.type(screen.getByRole("textbox", { name: "What students draw" }), "Draw a pond animal.");
    await user.type(screen.getByRole("textbox", { name: /^Sentence starters/ }), "I drew a ___.{Enter}It lives ___.");
    await user.click(screen.getByRole("button", { name: "Preview as student" }));

    const preview = await screen.findByRole("region", { name: "Preview as a student" });
    expect(district.callsTo("teacher.createActivity")[0]!.input.body!.activity).toMatchObject({
      template: "picture-response",
      lookPrompt: "Look at the pond.",
      drawPrompt: "Draw a pond animal.",
      tellAboutIt: true,
      sentenceFrames: ["I drew a ___.", "It lives ___."],
    });
    expect(within(preview).getByText("A drawing or a photo.")).toBeTruthy();
    expect(within(preview).getByText("A voice recording.")).toBeTruthy();
    expect(within(preview).getByText("Sentence starters: I drew a ___. · It lives ___.")).toBeTruthy();
  });

  it("lists what a picture response still needs", () => {
    const built = buildActivity({ ...emptyActivityForm(), template: "picture-response", title: "Pond", overview: "Ponds." }, CONTEXT);
    expect(built).toStrictEqual({ ok: false, problems: ["Say what students look at or listen to first.", "Say what students draw."] });
  });
});

describe("creating a read-and-respond activity", () => {
  it("makes each line a question, answered the way the teacher chose", () => {
    const form = emptyActivityForm();
    const built = buildActivity({
      ...form,
      template: "read-and-respond",
      title: "The frog's big jump",
      overview: "Listen to a story about Fred.",
      reading: { passage: "Fred the frog sat on a log.", questions: "What did Fred see?\n\n Where did Fred sit? ", answerBy: "drawing", sentenceFrames: "Fred saw a ___." },
    }, CONTEXT);
    expect(built).toMatchObject({
      ok: true,
      input: {
        template: "read-and-respond",
        gradeBand: "K-2",
        passage: "Fred the frog sat on a log.",
        questions: [{ prompt: "What did Fred see?" }, { prompt: "Where did Fred sit?" }],
        answerBy: "drawing",
        sentenceFrames: ["Fred saw a ___."],
      },
    });
    const empty = buildActivity({ ...form, template: "read-and-respond", title: "Fred", overview: "Fred." }, CONTEXT);
    expect(empty).toStrictEqual({ ok: false, problems: ["Write the text students hear.", "Add at least one question."] });
  });
});

describe("a submitted recording", () => {
  it("plays in an audio player, with a download named for its type", async () => {
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await act(async () => root.render(<SubmittedFile base64={btoa("\x1aE\xdf\xa3")} mediaType="audio/webm" label="Tell about it" />));
    expect(screen.getByLabelText("Tell about it").tagName).toBe("AUDIO");
    expect(screen.getByRole("link", { name: "Download Tell about it" }).getAttribute("download")).toBe("Tell about it.webm");
    act(() => root.unmount());
    container.remove();
  });
});
