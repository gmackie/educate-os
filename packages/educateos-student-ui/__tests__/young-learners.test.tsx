// SCHO-323: a K-2 class's activity is one step at a time with large type, read aloud on request,
// drawn on a drawing pad and answered by recording; secondary classes keep the standard page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import type { RouteName } from "@educateos/api-client";
import { ENGLISH, ESSAY, fakeDistrict, POND, READING_K2, type FakeDistrict } from "./fakeDistrict.ts";
import { announcement, renderApp } from "./render.tsx";

const PAGE = `/courses/${READING_K2}/activities/${POND}`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** The browser's speech synthesis, recording what it was asked to say. */
class FakeUtterance extends EventTarget {
  rate = 1;
  readonly text: string;
  constructor(text: string) {
    super();
    this.text = text;
  }
  /** The browser reaching a word, or the end. */
  fire(type: "boundary" | "end", detail: Record<string, unknown> = {}) {
    act(() => void this.dispatchEvent(Object.assign(new Event(type), detail)));
  }
}
let spoken: FakeUtterance[] = [];
const speech = { speak: vi.fn((utterance: FakeUtterance) => void spoken.push(utterance)), cancel: vi.fn() };
const installSpeech = () => {
  Object.assign(window, { speechSynthesis: speech, SpeechSynthesisUtterance: FakeUtterance });
};
const removeSpeech = () => {
  delete (window as { speechSynthesis?: unknown }).speechSynthesis;
  delete (window as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
};

/** A microphone and `MediaRecorder` that record WebM Opus. */
const installRecorder = (getUserMedia: () => Promise<unknown> = async () => ({ getTracks: () => [{ stop: vi.fn() }] })) => {
  class FakeRecorder extends EventTarget {
    static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
    state = "inactive";
    mimeType: string;
    constructor(_stream: unknown, options?: { mimeType?: string }) {
      super();
      this.mimeType = options?.mimeType ?? "";
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob([WEBM]) }));
      this.dispatchEvent(new Event("stop"));
    }
  }
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(getUserMedia) } });
};

/** A 2D canvas that draws nowhere and saves a PNG. */
const installCanvas = () => {
  const context = new Proxy({}, { get: (target: Record<string, unknown>, key: string) => (key in target ? target[key] : (target[key] = vi.fn())), set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
  HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
    callback(new Blob([PNG], { type: "image/png" }));
  };
};

beforeEach(() => {
  spoken = [];
  speech.speak.mockClear();
  speech.cancel.mockClear();
  installSpeech();
  installCanvas();
});

afterEach(() => {
  removeSpeech();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

async function openPond(district: FakeDistrict = fakeDistrict({ youngClass: true })) {
  const { container } = await renderApp(district, PAGE);
  await screen.findByRole("heading", { name: "Let's get started" });
  return { district, container, user: userEvent.setup() };
}

const createdWith = (district: FakeDistrict, type: string) =>
  district.calls.find((call) => call.name === "student.createArtifact" && (call.input as { body: { type: string } }).body.type === type)?.input;

describe("the young-learner activity page", () => {
  it("is used for a K-2 class: a start page, one step a page, and focus on each page's heading", async () => {
    const { container, user } = await openPond();
    expect(container.querySelector("[data-presentation='young']")).not.toBeNull();
    expect(screen.getByText("Start")).toBeTruthy();
    expect(screen.getByText("We are learning about pond animals.")).toBeTruthy();
    // Only the current page is shown.
    expect(screen.queryByRole("heading", { name: "Draw it" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Let's start" }));
    const look = screen.getByRole("heading", { name: "Look and listen" });
    expect(document.activeElement).toBe(look);
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    // A step with nothing to hand in is still a page.
    expect(screen.getByText("Look at the pond. What animals do you see?")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Draw it" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Look and listen" }));
  });

  it("reads the overview aloud, highlighting the word being spoken, and stops when the page changes", async () => {
    const { user } = await openPond();
    const read = screen.getByRole("button", { name: "Read what this activity is about to me" });
    expect(read.getAttribute("aria-pressed")).toBe("false");
    await user.click(read);
    expect(spoken.map((u) => u.text)).toStrictEqual(["We are learning about pond animals."]);
    expect(spoken[0]!.rate).toBeLessThan(1);
    expect(read.getAttribute("aria-pressed")).toBe("true");
    expect(announcement()).toBe("Reading what this activity is about aloud.");

    spoken[0]!.fire("boundary", { name: "word", charIndex: 22, charLength: 4 });
    expect(document.querySelector("mark")?.textContent).toBe("pond");
    spoken[0]!.fire("end");
    expect(read.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector("mark")).toBeNull();

    // Pressed again it stops; moving on stops it too.
    await user.click(read);
    await user.click(read);
    expect(read.getAttribute("aria-pressed")).toBe("false");
    await user.click(read);
    speech.cancel.mockClear();
    await user.click(screen.getByRole("button", { name: "Let's start" }));
    expect(speech.cancel).toHaveBeenCalled();
    expect(read.getAttribute("aria-pressed")).toBe("false");
  });

  it("hides read-aloud where the browser cannot speak", async () => {
    removeSpeech();
    await openPond();
    expect(screen.queryByRole("button", { name: /to me$/ })).toBeNull();
  });

  it("saves a drawing from the drawing pad as a PNG, with undo and clear", async () => {
    const { district, user } = await openPond();
    await user.click(screen.getByRole("button", { name: "Let's start" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    const canvas = screen.getByRole("img", { name: /^Drawing space for Draw it/ });
    const save = screen.getByRole("button", { name: "Save my drawing" });
    expect(save).toHaveProperty("disabled", true);

    await user.click(within(screen.getByRole("group", { name: "Pen colour" })).getByRole("button", { name: "Blue" }));
    expect(screen.getByRole("button", { name: "Blue" }).getAttribute("aria-pressed")).toBe("true");
    const stroke = () => {
      fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
      fireEvent.pointerMove(canvas, { clientX: 40, clientY: 30 });
      fireEvent.pointerUp(canvas, { clientX: 40, clientY: 30 });
    };
    stroke();
    expect(save).toHaveProperty("disabled", false);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(save).toHaveProperty("disabled", true);
    stroke();
    stroke();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(announcement()).toBe("Drawing cleared.");
    stroke();

    await user.click(save);
    await screen.findByRole("img", { name: "Who lives in the pond?: Draw it" });
    expect(createdWith(district, "image")).toMatchObject({
      body: { type: "image", title: "Who lives in the pond?: Draw it", content: { kind: "bytes", mediaType: "image/png", base64: base64(PNG) } },
    });
    // A fresh pad is left for another try, which would save as a new version.
    expect(screen.getByRole("button", { name: "Save my drawing" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Or add a photo (PNG or JPEG)")).toBeTruthy();
  });

  it("records a spoken answer, plays it back, and saves it as audio", async () => {
    installRecorder();
    const { district, user } = await openPond();
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole("button", { name: /^(Let's start|Next)$/ }));
    expect(screen.getByRole("heading", { name: "Tell about it" })).toBeTruthy();
    const starters = screen.getByRole("region", { name: "Sentence starters" });
    expect(within(starters).getAllByRole("listitem").map((item) => item.textContent)).toStrictEqual(["I drew a ___.", "It lives ___."]);
    // A starter is read with its blank as a pause.
    await user.click(within(starters).getByRole("button", { name: "Read “I drew a ___.” to me" }));
    expect(spoken.at(-1)!.text).toBe("I drew a  … .");

    await user.click(screen.getByRole("button", { name: "Record your answer for Tell about it" }));
    expect(await screen.findByRole("timer", { name: "Recording time" })).toBeTruthy();
    expect(announcement()).toBe("Recording. Press Stop when you're done.");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByLabelText("Your new recording")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Save my recording" }));
    await screen.findByLabelText("Who lives in the pond?: Tell about it");
    expect(createdWith(district, "audio")).toMatchObject({
      body: { type: "audio", content: { kind: "bytes", mediaType: "audio/webm", base64: base64(WEBM) } },
    });
    expect(announcement()).toBe("Your recording is saved.");
  });

  it("explains a refused microphone and takes an uploaded recording instead", async () => {
    installRecorder(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    const { district, user } = await openPond();
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole("button", { name: /^(Let's start|Next)$/ }));
    await user.click(screen.getByRole("button", { name: "Record your answer for Tell about it" }));
    expect(await screen.findByText("We can't use the microphone")).toBeTruthy();
    const upload = screen.getByLabelText("Upload a recording (M4A, MP3, WAV, WebM or Ogg)") as HTMLInputElement;
    await user.upload(upload, new File([WEBM], "telling.webm", { type: "audio/webm" }));
    await waitFor(() => expect(createdWith(district, "audio")).toMatchObject({ body: { content: { mediaType: "audio/webm", base64: base64(WEBM) } } }));
  });

  it("offers only an upload where the browser cannot record", async () => {
    await openPond();
    expect(screen.getByText("This browser can't record here. You can upload a recording instead.", { selector: "p" })).toBeTruthy();
  });

  it("finishes with I'm done!, in plain words", async () => {
    const { user } = await openPond();
    await user.click(screen.getByRole("button", { name: "Let's start" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    const canvas = screen.getByRole("img", { name: /^Drawing space/ });
    fireEvent.pointerDown(canvas, { clientX: 5, clientY: 5 });
    fireEvent.pointerUp(canvas, { clientX: 5, clientY: 5 });
    await user.click(screen.getByRole("button", { name: "Save my drawing" }));
    await screen.findByRole("img", { name: "Who lives in the pond?: Draw it" });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Finish" }));

    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "All done?" }));
    expect(screen.getByText("You saved 1 of 2. Go back to finish the rest.")).toBeTruthy();
    expect(screen.getByText("(not saved yet)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "I'm done!" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Hand in your work?")).toBeTruthy();
    // No attempt limit or receipt code for a five-year-old (SCHO-328).
    expect(within(dialog).queryByText(/up to \d+ times?/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Yes, hand it in" }));
    expect(await within(dialog).findByText("You did it!")).toBeTruthy();
    expect(within(dialog).queryByText("Receipt code")).toBeNull();
    expect(announcement()).toBe("You did it! Your work is handed in.");
  });

  it("shows the teacher's grade and scores as stars and kind words, never points, receipts or attempts (SCHO-328)", async () => {
    const district = fakeDistrict({ youngClass: true });
    const artifactId = district.addArtifact("wsp_amara-personal", "Who lives in the pond?: Draw it", "image", "image/png", { kind: "bytes", mediaType: "image/png", base64: base64(PNG) });
    const { revision } = await district.call("student.getArtifact", { params: { artifactId } });
    await district.call("student.submit", { params: { assignmentId: POND }, body: { revisions: [{ artifactId, revisionId: revision.id }] } });
    district.releaseFeedback(district.submissions[0]!.id, { comments: ["I love your frog!"], scores: [{ criterionId: "ideas", points: 2, maxPoints: 3 }] });
    district.recordGrade(POND, { points: 3, maxPoints: 3 });
    const { container, user } = await openPond(district);
    await user.click(screen.getByRole("button", { name: "Let's start" }));
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole("button", { name: /^(Next|Finish)$/ }));

    const finish = screen.getByRole("region", { name: "All done?" });
    expect(await within(finish).findByText("I love your frog!")).toBeTruthy();
    expect(within(finish).getByRole("img", { name: "3 of 3 stars" })).toBeTruthy();
    expect(within(finish).getByText("Great work!")).toBeTruthy();
    expect(within(finish).getByRole("img", { name: "2 of 3 stars" })).toBeTruthy();
    expect(within(finish).getByText(/You handed this in/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/Receipt code|Official grade|out of 3|2 of 3\b(?! stars)|Attempt 1/);
  });
});

describe("an upper-elementary class", () => {
  it("keeps the standard page, with read-aloud on the instructions and the drawing pad", async () => {
    const { container } = await renderApp(fakeDistrict({ youngClass: { gradeBand: "3-5" } }), PAGE);
    await screen.findByRole("heading", { name: "Instructions" });
    expect(container.querySelector("[data-presentation='young']")).toBeNull();
    expect(screen.getByRole("button", { name: "Read the instructions to me" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Read Draw it to me" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /^Drawing space for Draw it/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
  });
});

describe("secondary classes", () => {
  it("keep the standard activity page, with no read-aloud or drawing pad", async () => {
    const { container } = await renderApp(fakeDistrict({ youngClass: true }), `/courses/${ENGLISH}/activities/${ESSAY}`);
    await screen.findByRole("heading", { name: "Instructions" });
    expect(container.querySelector("[data-presentation='young']")).toBeNull();
    expect(screen.queryByRole("button", { name: /to me$/ })).toBeNull();
  });
});

describe("a young class's quiz", () => {
  const QUESTION = { id: "qzi_1", type: "multiple-choice", prompt: "Which animal lives in a pond?", points: 1, choices: [{ id: "c1", text: "Frog" }, { id: "c2", text: "Camel" }] };

  function withQuiz() {
    const base = fakeDistrict({ youngClass: true });
    const quiz = {
      id: "qz_pond", offeringId: READING_K2, courseTitle: "Kindergarten Science", title: "Pond check", description: "", assignmentId: "asg_pond-quiz",
      questionCount: 1, totalPoints: 1, attemptsAllowed: 1, showAnswers: "after-release", availability: "open", attempts: [], canStart: true,
    };
    const attempt = { attemptId: "qza_1", quizId: "qz_pond", title: "Pond check", number: 1, questions: [QUESTION], answers: [], startedAt: "2026-10-21T15:00:00.000Z", serverNow: "2026-10-21T15:00:00.000Z" };
    const handlers: Partial<Record<RouteName, () => unknown>> = { "student.getQuiz": () => quiz, "student.startQuizAttempt": () => attempt };
    const district: FakeDistrict = {
      ...base,
      async call(name, ...args) {
        const handler = handlers[name];
        if (handler === undefined) return base.call(name, ...args);
        await Promise.resolve();
        return structuredClone(handler()) as never;
      },
    };
    return district;
  }

  it("reads each question and its choices aloud, and shows the choices as large cards", async () => {
    await renderApp(withQuiz(), `/courses/${READING_K2}/quizzes/qz_pond`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Start/ }));
    await user.click(await screen.findByRole("button", { name: "Read question 1 to me" }));
    expect(spoken.at(-1)!.text).toBe("Which animal lives in a pond?\nFrog.\nCamel.");
    await user.click(screen.getByRole("radio", { name: "Frog" }));
    expect(screen.getByRole("radio", { name: "Frog" }).getAttribute("aria-checked")).toBe("true");
  });
});
