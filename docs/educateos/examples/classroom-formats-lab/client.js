const exportId = globalThis.gadgetExportFormatId;
const prefs = exportId
  ? {
      course: exportId.split("-")[0],
      format: exportId.includes("worksheet") ? "worksheet" : "deck",
    }
  : await gadget.getPreferences();
let course = prefs.course,
  format = prefs.format,
  data,
  slide = 0,
  loadGeneration = 0,
  timer = null,
  seconds = 180;
const el = (tag, text, attrs = {}) => {
  const n = document.createElement(tag);
  if (text !== null) n.textContent = text;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const style = el(
  "style",
  `*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,sans-serif;color:var(--color-kumo-default,#18202b);background:var(--color-kumo-base,#f4f6f8)}button,select,input{font:inherit}button,select{padding:.5rem .85rem;border:1px solid currentColor;border-radius:.5rem;background:var(--color-kumo-base,#fff);color:inherit;cursor:pointer}button:disabled{opacity:.45;cursor:default}button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid currentColor;outline-offset:3px}header,nav,.toolbar{display:flex;gap:.7rem;align-items:center;flex-wrap:wrap}header{padding:1.2rem;border-bottom:1px solid #ccd2d9}header h1{font-size:1.25rem;margin:0 auto 0 0}nav{padding:1rem}main{max-width:1100px;margin:auto;padding:1rem}.card,.slide{padding:1.7rem;background:var(--color-kumo-base,#fff);border:1px solid #ccd2d9;border-radius:.8rem;margin-bottom:1rem;overflow-wrap:anywhere}h2{font-size:1.6rem;line-height:1.25}h3{margin-bottom:.4rem}.muted,footer{font-size:.8rem;color:var(--color-kumo-subtle,#52606d)}.badge{font-size:.8rem;border:1px solid;padding:.2rem .5rem;border-radius:.4rem}.lines{height:150px;background:repeating-linear-gradient(transparent,transparent 29px,#aeb7c2 30px)}fieldset{padding:1rem;margin:1rem 0;border:1px solid #ccd2d9;border-radius:.5rem}legend{font-weight:650}label.option{display:flex;gap:.7rem;padding:.65rem;align-items:flex-start}.feedback{padding:.6rem;border-left:3px solid currentColor;margin:.5rem 0}.slide{min-height:420px;display:flex;flex-direction:column;justify-content:center}.slide p{font-size:1.25rem;white-space:pre-line}.slide footer{margin-top:auto;padding-top:2rem}.timer{font-variant-numeric:tabular-nums;font-size:2rem}.notice{border-left:4px solid currentColor;padding:.7rem 1rem;background:var(--color-kumo-base,#fff)}.source{overflow-wrap:anywhere}summary{cursor:pointer;font-weight:600}@media(max-width:500px){main{padding:.5rem}.card,.slide{padding:1rem}header{padding:.8rem}.slide{min-height:350px}nav{gap:.4rem}}@media print{body{background:white;color:black}header,nav,.toolbar,.notice,.no-print{display:none!important}main{max-width:none;padding:0}.card,.slide{border:0;border-radius:0;box-shadow:none}.slide{break-after:page;min-height:650px}.slide:last-child{break-after:auto}.worksheet{break-after:auto}.response-start{break-before:page}.lines{height:180px}.source{font-size:10px}details{display:none}}`,
);
document.head.append(style);
const header = el("header", null);
header.append(
  el("h1", "Assignment Formats Lab"),
  el("span", "Teacher-authorized preview", { class: "badge" }),
);
const select = el("select", null, { "aria-label": "Class" });
for (const [v, t] of [
  ["science", "Earth Science · Weathering"],
  ["algebra", "Algebra I · Equations"],
]) {
  const o = el("option", t, { value: v });
  select.append(o);
}
select.value = course;
header.append(select);
const refresh = el("button", "Refresh live assignment");
header.append(refresh);
const nav = el("nav", null, { "aria-label": "Presentation format" });
const main = el("main", null);
const status = el("p", "", { role: "status", "aria-live": "polite" });
main.append(status);
document.body.replaceChildren(header, nav, main);
for (const [v, t] of [
  ["worksheet", "Worksheet"],
  ["deck", "Slide deck"],
  ["quiz", "Practice quiz"],
  ["discussion", "Discussion"],
]) {
  const b = el("button", t, { "data-format": v });
  b.addEventListener("click", () => {
    format = v;
    slide = 0;
    stopTimer();
    save();
    render();
  });
  nav.append(b);
}
select.addEventListener("change", async () => {
  course = select.value;
  slide = 0;
  stopTimer();
  await save();
  await load();
});
refresh.addEventListener("click", load);
async function save() {
  if (!exportId) await gadget.setPreferences({ course, format });
}
function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
function source() {
  return el(
    "footer",
    `Course ${data.source.courseId} · Coursework ${data.source.courseWorkId} · Fetched ${data.lastFetched}`,
    { class: "source" },
  );
}
function card(title) {
  const c = el("section", null, { class: "card" });
  c.append(el("h2", title));
  return c;
}
function para(c, text) {
  if (text) c.append(el("p", text));
}
function worksheet() {
  const c = card(data.assignment.title);
  c.classList.add("worksheet");
  para(c, `${data.course.name} · ${data.assignment.maxPoints} points`);
  c.append(el("h3", "Learning goal"));
  para(c, data.parsed.goal);
  c.append(el("h3", "Your task"));
  if (data.parsed.steps.length) {
    const ol = el("ol", null);
    for (const s of data.parsed.steps) ol.append(el("li", s));
    c.append(ol);
  } else {
    para(c, data.parsed.example);
    para(c, data.parsed.practice);
  }
  c.append(el("h3", "Success criteria"));
  para(c, data.parsed.criteria);
  for (const r of data.rubrics)
    for (const x of r.criteria)
      para(
        c,
        `${x.title}: ${x.description || ""} (${x.levels.map((l) => `${l.title}: ${l.points ?? "unscored"}`).join("; ")})`,
      );
  c.append(
    el(
      "h3",
      course === "science"
        ? "Observations, claim, evidence and reasoning"
        : "Show equivalent operations and check your solutions",
      { class: "response-start" },
    ),
  );
  c.append(el("div", null, { class: "lines", "aria-label": "Answer space" }));
  c.append(
    el("h3", "Question for discussion"),
    el("div", null, { class: "lines", "aria-label": "Discussion answer space" }),
    source(),
  );
  return c;
}
function deck() {
  const wrap = el("section", null);
  const slides = exportId ? data.slides : [data.slides[slide]];
  for (const [s, i] of slides.map((s, i) => [s, exportId ? i : slide])) {
    const c = el("article", null, {
      class: "slide",
      "aria-label": `Slide ${i + 1} of ${data.slides.length}`,
    });
    c.append(
      el("p", `${i + 1} / ${data.slides.length}`, { class: "muted" }),
      el("h2", s.title),
      el("p", s.body),
      source(),
    );
    wrap.append(c);
  }
  if (!exportId) {
    const t = el("div", null, { class: "toolbar" });
    const prev = el("button", "Previous slide");
    prev.disabled = slide === 0;
    prev.addEventListener("click", () => {
      slide--;
      render();
    });
    const next = el("button", "Next slide");
    next.disabled = slide === data.slides.length - 1;
    next.addEventListener("click", () => {
      slide++;
      render();
    });
    t.append(prev, next);
    wrap.append(t);
  }
  return wrap;
}
function questions() {
  return course === "science"
    ? [
        {
          q: "A rock breaks into smaller pieces without changing its minerals. Which process occurred?",
          options: ["Physical weathering", "Chemical weathering", "Neither"],
          answer: 0,
          why: "Physical weathering changes size or shape without changing mineral composition.",
        },
        {
          q: "Which observation best supports a chemical-weathering claim?",
          options: [
            "A fresh crack after freezing",
            "A rusty coating and a new mineral on an iron-rich rock",
            "Two smaller pieces of the same rock",
          ],
          answer: 1,
          why: "A new substance such as an iron oxide supports a chemical change.",
        },
        {
          q: "Why include an alternative explanation in your investigation?",
          options: [
            "To replace observations with guesses",
            "To test whether another process could explain the same evidence",
            "To avoid giving a claim",
          ],
          answer: 1,
          why: "Comparing alternatives tests how strongly the observations support your claim.",
        },
      ]
    : [
        {
          q: "Solve 2x + 7 = 15.",
          options: ["x = 4", "x = 11", "x = 8"],
          answer: 0,
          why: "Subtract 7 from both sides, then divide both sides by 2. Check: 2(4)+7=15.",
        },
        {
          q: "Solve 4x − 3 = 9.",
          options: ["x = 1.5", "x = 3", "x = 12"],
          answer: 1,
          why: "Add 3 to both sides: 4x=12, then divide by 4. Check: 4(3)−3=9.",
        },
        {
          q: "Solve 5x + 2 = 2x + 14.",
          options: ["x = 4", "x = 12", "x = 2"],
          answer: 0,
          why: "Subtract 2x and 2 from both sides: 3x=12, so x=4. Both original sides equal 22.",
        },
      ];
}
function quiz() {
  const c = card("Practice quiz");
  para(
    c,
    "Local practice only. Answers are not saved or sent to Google Classroom; no grade passback.",
  );
  const form = el("section", null);
  const qs = questions();
  qs.forEach((q, i) => {
    const f = el("fieldset", null);
    f.append(el("legend", `${i + 1}. ${q.q}`));
    q.options.forEach((a, j) => {
      const label = el("label", null, { class: "option" });
      const input = el("input", null, {
        type: "radio",
        name: "q" + i,
        value: String(j),
        required: "",
      });
      label.append(input, el("span", a));
      f.append(label);
    });
    form.append(f);
  });
  const submit = el("button", "Check answers", { type: "button" }),
    reset = el("button", "Reset practice", { type: "button" }),
    result = el("div", "", { role: "status", "aria-live": "polite" });
  form.append(submit, reset, result);
  submit.addEventListener("click", () => {
    if (qs.some((q, i) => !form.querySelector('input[name="q' + i + '"]:checked'))) {
      result.textContent = "Answer every question before checking.";
      return;
    }
    form.querySelectorAll(".feedback").forEach((n) => n.remove());
    let score = 0;
    qs.forEach((q, i) => {
      const correct =
        Number(form.querySelector('input[name="q' + i + '"]:checked').value) === q.answer;
      if (correct) score++;
      form
        .querySelectorAll("fieldset")
        .item(i)
        .append(el("p", (correct ? "Correct. " : "Review. ") + q.why, { class: "feedback" }));
    });
    result.textContent = `${score} of ${qs.length} correct. Local practice complete.`;
  });
  reset.addEventListener("click", () => {
    form.querySelectorAll("input").forEach((n) => (n.checked = false));
    form.querySelectorAll(".feedback").forEach((n) => n.remove());
    result.textContent = "Practice reset. Answers cleared.";
  });
  c.append(form, source());
  return c;
}
function discussion() {
  const c = card("Discussion and seminar");
  para(c, data.assignment.title);
  const prompt =
    course === "science"
      ? "Which observations distinguish physical from chemical weathering, and what else could explain them?"
      : "How can you justify each equivalent operation, and how does substitution reveal an incorrect solution?";
  para(c, prompt);
  const ol = el("ol", null);
  for (const t of [
    "2 minutes · Quiet thinking and evidence gathering",
    "3 minutes · Partner explanation; listener asks one probing question",
    "4 minutes · Compare claims or solution paths as a group",
    "2 minutes · Revise your explanation and share an exit response",
  ])
    ol.append(el("li", t));
  c.append(ol, el("h3", "Rotating roles"));
  para(
    c,
    "Facilitator · Evidence checker · Timekeeper · Reporter. Use role names without collecting participant identities.",
  );
  const clock = el("div", "03:00", {
    class: "timer",
    role: "timer",
    "aria-label": "Discussion timer",
  });
  seconds = 180;
  const show = () => {
    clock.textContent = `${Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  };
  const toolbar = el("div", null, { class: "toolbar" });
  const start = el("button", "Start timer");
  start.addEventListener("click", () => {
    if (timer) return;
    timer = setInterval(() => {
      seconds = Math.max(0, seconds - 1);
      show();
      if (!seconds) {
        stopTimer();
        start.textContent = "Start timer";
      }
    }, 1000);
  });
  const pause = el("button", "Pause timer");
  pause.addEventListener("click", stopTimer);
  const reset = el("button", "Reset timer");
  reset.addEventListener("click", () => {
    stopTimer();
    seconds = 180;
    show();
  });
  toolbar.append(start, pause, reset);
  c.append(clock, toolbar);
  const notes = el("details", null);
  notes.append(el("summary", "Teacher facilitation notes"));
  para(
    notes,
    course === "science"
      ? "Ask learners to separate observations from interpretations. Probe alternatives. Do not require photographs, personal locations, or risky sample collection."
      : "Ask what changed on each side and why equality is preserved. Invite a second solution path. Use substitution to check errors without naming learners.",
  );
  c.append(notes, source());
  return c;
}
function render() {
  stopTimer();
  main.replaceChildren();
  for (const b of nav.querySelectorAll("button"))
    b.setAttribute("aria-pressed", String(b.dataset.format === format));
  if (!exportId)
    main.append(
      el(
        "p",
        "Teacher-authorized presentation preview. This gadget is not a student-scoped sharing permission.",
        { class: "notice" },
      ),
    );
  for (const warning of data.warnings) main.append(el("p", warning, { role: "status" }));
  main.append({ worksheet, deck, quiz, discussion }[format]());
  if (!exportId)
    main.append(
      el(
        "p",
        "Use Workshop’s Export Gadget menu for class-specific worksheet PDF, deck PDF, or PowerPoint. Exports contain assignment content and source references only.",
        { class: "muted" },
      ),
    );
}
async function load() {
  const generation = ++loadGeneration;
  refresh.disabled = true;
  main.replaceChildren(el("p", "Loading published assignment…", { role: "status" }));
  try {
    const result = await gadget.fetchLesson(course);
    if (generation !== loadGeneration) return;
    data = result;
    render();
  } catch (e) {
    if (generation === loadGeneration)
      main.replaceChildren(
        el("h2", "Assignment unavailable"),
        el("p", e.message, { role: "alert" }),
        el("p", "Use Refresh live assignment to retry. No stale assignment is shown."),
      );
  } finally {
    if (generation === loadGeneration) refresh.disabled = false;
  }
}
document.addEventListener("keydown", (e) => {
  if (
    format !== "deck" ||
    exportId ||
    ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(e.target.tagName)
  )
    return;
  if (e.key === "ArrowRight" && slide < data.slides.length - 1) {
    slide++;
    render();
  }
  if (e.key === "ArrowLeft" && slide > 0) {
    slide--;
    render();
  }
});
window.addEventListener("pagehide", stopTimer);
await load();
if (exportId) {
  header.remove();
  nav.remove();
  if (!data) throw Error("Cannot export unavailable assignment");
}
