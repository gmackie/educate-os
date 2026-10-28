import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { deckToPptx } from "../../../../packages/bundled-blueprints/libraries/pptx/server.ts";
const CLASSES = {
  science: { binding: "SCIENCE", courseId: "895811762849", workId: "896258346598" },
  algebra: { binding: "ALGEBRA", courseId: "896141390025", workId: "896261051224" },
};
function parseDescription(text = "") {
  const goal = (text.match(/Learning goal:\s*(.*?)(?=\.\s|$)/i)?.[1] || "").trim();
  const criteria = (text.match(/Success criteria:\s*(.*?)(?=\.\s|$)/i)?.[1] || "").trim();
  const steps = [...text.matchAll(/(?:^|\s)\d\.\s*(.*?)(?=\s\d\.\s|Success criteria:|$)/g)].map(
    (m) => m[1].trim(),
  );
  const example = (
    text.match(/Worked example:\s*(.*?)(?=Independent practice:|Success criteria:|$)/i)?.[1] || ""
  ).trim();
  const practice = (
    text.match(/Independent practice:\s*(.*?)(?=Success criteria:|$)/i)?.[1] || ""
  ).trim();
  return { goal, criteria, steps, example, practice };
}
function slideContent(d) {
  const p = d.parsed;
  return [
    {
      title: d.assignment.title,
      body: `${d.course.name}\n${d.assignment.maxPoints} points · Published assignment\nTeacher-authorized presentation`,
    },
    { title: "Learning goal", body: p.goal },
    ...p.steps.map((body, i) => ({ title: `Investigation · ${i + 1}`, body })),
    ...(p.example
      ? [
          { title: "Worked example", body: p.example },
          { title: "Independent practice", body: p.practice },
        ]
      : []),
    { title: "Success criteria", body: p.criteria },
    {
      title: "Discuss and explain",
      body:
        d.courseKey === "science"
          ? "What evidence distinguishes physical and chemical weathering? Explain an alternative interpretation of your observations."
          : "Why must an operation be applied to both sides? Compare two valid solution paths and check by substitution.",
    },
    {
      title: "Assignment source",
      body: `Course ${d.source.courseId}\nCoursework ${d.source.courseWorkId}\nFetched ${d.lastFetched}\nSynthetic customer demo · No roster, submissions or grades included.`,
    },
  ];
}
export class Gadget extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
  }
  async getPreferences() {
    return (await this.state.storage.get("prefs")) || { course: "science", format: "worksheet" };
  }
  async setPreferences(p) {
    if (!CLASSES[p.course] || !["worksheet", "deck", "quiz", "discussion"].includes(p.format))
      throw Error("Invalid view");
    await this.state.storage.put("prefs", { course: p.course, format: p.format });
  }
  async fetchLesson(courseKey) {
    const c = CLASSES[courseKey];
    if (!c) throw Error("Unknown class");
    const session = this.env[c.binding];
    const coursePromise = session.getCourse();
    const workPromise = session.getCourseWork(c.workId);
    const [course, work] = await Promise.all([coursePromise, workPromise]);
    if (work.pending || work.state !== "PUBLISHED")
      throw Error(
        "This assignment is not published and committed. It is hidden from presentation and exports.",
      );
    // Explicit projection keeps all presentation and export paths free of learner data.
    const assignment = {
      id: work.id,
      title: work.title,
      description: work.description || "",
      maxPoints: work.maxPoints,
      state: work.state,
    };
    let rubrics = [],
      warnings = [];
    try {
      rubrics = (await session.listRubrics(c.workId)).map((r) => ({
        criteria: r.criteria.map((x) => ({
          title: x.title,
          description: x.description,
          levels: x.levels.map((l) => ({
            title: l.title,
            points: l.points,
            description: l.description,
          })),
        })),
      }));
    } catch {
      warnings.push("Rubric is currently unavailable; assignment success criteria remain visible.");
    }
    const result = {
      courseKey,
      course: { name: course.name, id: course.id },
      assignment,
      rubrics,
      parsed: parseDescription(assignment.description),
      source: { courseId: c.courseId, courseWorkId: c.workId },
      lastFetched: new Date().toISOString(),
      warnings,
    };
    return { ...result, slides: slideContent(result) };
  }
  async getDeck(courseKey) {
    const d = await this.fetchLesson(courseKey);
    return {
      slides: d.slides.map((s, i) => ({
        id: "slide-" + i,
        background: { color: "#ffffff" },
        blocks: [
          {
            id: "title",
            type: "text",
            x: 64,
            y: 50,
            w: 1072,
            h: 110,
            props: { text: s.title, fontSize: 36, weight: 700, color: "#111111" },
          },
          {
            id: "body",
            type: "text",
            x: 64,
            y: 180,
            w: 1072,
            h: 370,
            props: { text: s.body, fontSize: 24, color: "#222222" },
          },
          {
            id: "footer",
            type: "text",
            x: 64,
            y: 610,
            w: 1072,
            h: 35,
            props: {
              text: `${i + 1}/${d.slides.length} · Course ${d.source.courseId} · Work ${d.source.courseWorkId} · ${d.lastFetched}`,
              fontSize: 12,
              color: "#555555",
            },
          },
        ],
      })),
    };
  }
}
const formats = ["science", "algebra"].flatMap((c) => [
  {
    id: c + "-worksheet-pdf",
    label: (c === "science" ? "Science" : "Algebra") + " worksheet PDF",
    mode: "browser",
    contentType: "application/pdf",
    fileExtension: ".pdf",
  },
  {
    id: c + "-deck-pdf",
    label: (c === "science" ? "Science" : "Algebra") + " slide deck PDF",
    mode: "browser",
    contentType: "application/pdf",
    fileExtension: ".pdf",
  },
  {
    id: c + "-pptx",
    label: (c === "science" ? "Science" : "Algebra") + " PowerPoint",
    mode: "server",
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    fileExtension: ".pptx",
  },
]);
export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats() {
    return formats;
  }
  async export(gadget, id) {
    if (!["science-pptx", "algebra-pptx"].includes(id)) throw Error("Unsupported export");
    const deck = await gadget.getDeck(id.split("-")[0]);
    return deckToPptx(deck);
  }
}
