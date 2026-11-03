// SCHO-323: the K-2 templates. They generate the same runtime model as every other template, so
// nothing downstream branches on them; only their steps ask for pictures and recordings.
import { describe, expect, it } from "vitest";
import { ActivityContent, checkActivityContent, generateActivity, ResourceReleaseRef, TemplateInput } from "../src/index.ts";
import { CHIDI, MATH7, PATEL, setup } from "./helpers.ts";

const common = {
  subject: "science",
  gradeBand: "K-2",
  overview: "We are learning about animals that live in a pond.",
  aiHelp: "none",
  due: { kind: "none" },
} as const;

const pondPicture = (overrides: Record<string, unknown> = {}) => ({
  template: "picture-response",
  title: "Who lives in the pond?",
  ...common,
  lookPrompt: "Look at the pond picture. What animals do you see?",
  drawPrompt: "Draw an animal that lives in a pond.",
  sentenceFrames: ["I drew a ___.", "It lives ___."],
  ...overrides,
}) as TemplateInput;

const frogStory = (overrides: Record<string, unknown> = {}) => ({
  template: "read-and-respond",
  title: "The frog's big jump",
  ...common,
  passage: "Fred the frog sat on a log. He saw a fly. Fred jumped high and caught it!",
  questions: [{ prompt: "What did Fred see?" }, { prompt: "Draw Fred on his log.", answerBy: "drawing" }],
  sentenceFrames: ["Fred saw a ___."],
  ...overrides,
}) as TemplateInput;

describe("picture-response", () => {
  it("looks, draws and tells, keeping the drawing as an image and the telling as audio", () => {
    const picture = ResourceReleaseRef.parse({ resourceId: "rsc_pond", version: "1.0.0" });
    const content = generateActivity(pondPicture({ resources: [picture] }));
    expect(content.steps.map((s) => [s.id, s.title, s.response])).toStrictEqual([
      ["look", "Look and listen", { kind: "none" }],
      ["draw", "Draw it", { kind: "artifact", artifactType: "image" }],
      ["tell", "Tell about it", { kind: "artifact", artifactType: "audio" }],
    ]);
    // The picture to look at is the first step's source; the starters go with the telling.
    expect(content.steps[0]!.sources).toStrictEqual([picture]);
    expect(content.steps[2]!.sentenceFrames).toStrictEqual(["I drew a ___.", "It lives ___."]);
    expect(content.steps[1]).not.toHaveProperty("sentenceFrames");
    expect(content.permittedArtifactTypes).toStrictEqual(["image", "audio"]);
    expect(content.evidence.responseType).toBe("artifact");
    expect(content.evidence.criteria.map((c) => c.id)).toStrictEqual(["answers-prompt", "shows-detail", "tells-about-it"]);
    expect(checkActivityContent(content)).toStrictEqual([]);
    expect(ActivityContent.parse(content)).toStrictEqual(content);
  });

  it("can leave out the telling, moving the starters to the drawing", () => {
    const content = generateActivity(pondPicture({ tellAboutIt: false }));
    expect(content.steps.map((s) => s.id)).toStrictEqual(["look", "draw"]);
    expect(content.steps[1]!.sentenceFrames).toStrictEqual(["I drew a ___.", "It lives ___."]);
    expect(content.permittedArtifactTypes).toStrictEqual(["image"]);
    expect(content.evidence.criteria.map((c) => c.id)).not.toContain("tells-about-it");
  });

  it("refuses a missing drawing prompt and too many starters", () => {
    expect(() => generateActivity(pondPicture({ drawPrompt: " " }))).toThrow();
    expect(() => generateActivity(pondPicture({ sentenceFrames: Array.from({ length: 11 }, (_, i) => `Frame ${i} ___.`) }))).toThrow();
  });
});

describe("read-and-respond", () => {
  it("listens, then answers one question a step, by speaking unless a question says otherwise", () => {
    const content = generateActivity(frogStory());
    expect(content.steps.map((s) => [s.id, s.response])).toStrictEqual([
      ["listen", { kind: "none" }],
      ["question-1", { kind: "artifact", artifactType: "audio" }],
      ["question-2", { kind: "artifact", artifactType: "image" }],
    ]);
    expect(content.steps[0]!.prompt).toBe("Fred the frog sat on a log. He saw a fly. Fred jumped high and caught it!");
    expect(content.steps.slice(1).every((s) => s.sentenceFrames?.[0] === "Fred saw a ___.")).toBe(true);
    expect(content.permittedArtifactTypes).toStrictEqual(["audio", "image"]);
    // Mixed answers are artifacts; one kind throughout names it.
    expect(content.evidence.responseType).toBe("artifact");
    expect(checkActivityContent(content)).toStrictEqual([]);
  });

  it("names the evidence by the one way every question is answered", () => {
    const spoken = generateActivity(frogStory({ questions: [{ prompt: "What did Fred see?" }] }));
    expect(spoken.evidence.responseType).toBe("audio");
    const written = generateActivity(frogStory({ answerBy: "writing", questions: [{ prompt: "What did Fred see?" }, { prompt: "Where did Fred sit?" }] }));
    expect(written.evidence.responseType).toBe("text");
    expect(written.steps.slice(1).map((s) => s.response.kind)).toStrictEqual(["writing", "writing"]);
    expect(written.permittedArtifactTypes).toStrictEqual(["document"]);
  });

  it("refuses an activity with no questions or an unknown way of answering", () => {
    expect(() => generateActivity(frogStory({ questions: [] }))).toThrow();
    expect(() => generateActivity(frogStory({ answerBy: "singing" }))).toThrow();
  });
});

describe("the young-learner templates through the curriculum service", () => {
  it("are drafted, published, installed and read by a student like any other", async () => {
    const { service } = await setup();
    for (const input of [pondPicture(), frogStory()]) {
      const draft = await service.createDraft(PATEL, { scope: MATH7, activity: input });
      expect(draft.content.template).toBe(input.template);
      expect(draft.evidenceContract.responseType).toBe(draft.content.evidence.responseType);
      const published = await service.publish(PATEL, draft.id);
      const installation = await service.install(PATEL, { definitionId: published.id, offering: MATH7 });
      const view = await service.getActivity(CHIDI, installation.id);
      expect(view.content.steps).toStrictEqual(draft.content.steps);
    }
  });
});
