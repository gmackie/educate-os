/** The shared, dependency-free teacher board UI, bundled into each installed gadget. */
import { el } from "@gadgets/bundled-blueprints/libraries/ui/client";
import type { BoardApi, BoardOptions, BoardResult, Preparation } from "./src/protocol.ts";
export type { BoardApi, BoardOptions, BoardResult } from "./src/protocol.ts";

/** Mount a teacher board. Sample data is opt-in, labeled, and never persisted. */
export function mountBoard(api: BoardApi, options: BoardOptions): void {
  const style = el("style", { text: `
    *{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#172b32;font:15px/1.55 system-ui,sans-serif}
    main{max-width:1040px;margin:auto;padding:32px 24px}h1{font-size:clamp(28px,5vw,40px);line-height:1.12;letter-spacing:-.04em;margin:10px 0 14px}
    h2{font-size:19px;margin:0 0 16px}p{margin:8px 0}.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;font-weight:700;color:#176a63}
    .lede{max-width:64ch;color:#52666c}.toolbar{display:flex;align-items:end;gap:10px;flex-wrap:wrap;margin:24px 0}
    button,input,textarea{font:inherit}button{cursor:pointer;padding:10px 16px;border-radius:9px;border:1px solid #b7c9c7;background:white;color:inherit;font-weight:650}
    button.primary{background:#12675e;border-color:#12675e;color:white}button:disabled{opacity:.55;cursor:wait}button:hover:not(:disabled){filter:brightness(.95)}
    input,textarea{border:1px solid #b7c9c7;border-radius:8px;padding:10px;color:inherit;background:white;max-width:100%}
    input[type=search]{width:min(440px,100%)}label{display:block;font-size:13px;font-weight:650}label input{display:block;margin-top:5px}
    :focus-visible{outline:3px solid #318dba;outline-offset:3px}.layout{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(240px,1fr);gap:24px}
    .panel{background:white;border:1px solid #dce5e6;border-radius:16px;padding:22px;min-width:0}.card{padding:18px 0;border-top:1px solid #e3eaeb}.card:first-child{border-top:0}
    .card h3{font-size:17px;margin:6px 0}.card p{white-space:pre-wrap;overflow-wrap:anywhere;color:#52666c}.tag{font-size:12px;font-weight:700;color:#176a63}
    a{color:#12675e;text-underline-offset:3px;overflow-wrap:anywhere}.status{padding:12px 16px;border-radius:9px;background:#e7f1ee;margin:12px 0 22px;overflow-wrap:anywhere}
    .status.error{background:#ffede5;color:#873916}.muted{font-size:13px;color:#52666c}.source-heading{margin-bottom:4px}.tasks{padding:0;list-style:none}.task{display:flex;gap:8px;align-items:start;margin:12px 0}
    .task label{flex:1;display:flex;align-items:baseline;gap:8px;font-weight:400;overflow-wrap:anywhere}.task input{display:inline}.task button{padding:0 7px;background:none;border:0}
    textarea{width:100%;min-height:150px;resize:vertical}.task-form{display:flex;gap:7px}.task-form input{width:100%;min-width:0}.task-form{margin-bottom:12px}.print-notes{display:none}.setup{margin-top:24px;font-size:13px;color:#52666c}.setup summary{cursor:pointer;font-weight:700}
    @media print{body{background:white;color:black}main{max-width:none;padding:0}.toolbar,.setup,.task-form,.task button,aside>button,aside>textarea,aside>label{display:none}.layout{display:block}.panel{break-inside:avoid;margin-bottom:16px;border-color:#aaa}.card{break-inside:avoid}.print-notes{display:block;white-space:pre-wrap}.status{background:none;border:1px solid #aaa}}
    @media(max-width:680px){main{padding:24px 16px}.layout{grid-template-columns:1fr}.panel{padding:18px}.toolbar label{width:100%}}
    @media(prefers-color-scheme:dark){body{background:#122126;color:#e7eff0}.panel,button,input,textarea{background:#1b3037;color:#e7eff0;border-color:#405b62}.lede,.muted,.card p,.setup{color:#afc4c9}.eyebrow,.tag,a{color:#8ad6c3}.card{border-color:#405b62}.status{background:#22443e}.status.error{background:#503328;color:#ffcfb2}}
  ` });
  const status = el("div", { class: "status", role: "status", "aria-live": "polite", text: "Refresh to load your connected source, or explore the fictional example." });
  const source = el("section", { class: "panel", "aria-label": "Connected source" });
  const input = el("input", { id: "source-input", type: options.inputType === "none" ? "text" : options.inputType, value: options.inputValue, maxlength: 1024 });
  const refresh = el("button", { class: "primary", text: "Refresh source" });
  const sample = el("button", { text: "Try fictional example" });
  const notes = el("textarea", { id: "teacher-notes", maxlength: 12000, placeholder: "What would you like to prepare?" });
  const printedNotes = el("p", { class: "print-notes" });
  const tasks = el("ul", { class: "tasks" });
  const taskInput = el("input", { "aria-label": "New preparation task", placeholder: "Add a preparation task", maxlength: 300 });
  const save = el("button", { text: "Save preparation", disabled: true });
  const saveStatus = el("p", { class: "muted", role: "status", text: "Loading your preparation…" });
  let preparation: Preparation = { notes: "", tasks: [] };
  let loaded = false;
  let dirtyVersion = 0;
  let savedVersion = 0;
  const changed = () => { dirtyVersion++; saveStatus.textContent = "Unsaved preparation"; };
  const drawTasks = () => {
    tasks.replaceChildren(...preparation.tasks.map(task => {
      const checkbox = el("input", { type: "checkbox", "aria-label": task.text });
      checkbox.checked = task.done;
      checkbox.addEventListener("change", () => { task.done = checkbox.checked; changed(); });
      const remove = el("button", { type: "button", text: "×", "aria-label": "Remove " + task.text });
      remove.addEventListener("click", () => { preparation.tasks = preparation.tasks.filter(t => t.id !== task.id); changed(); drawTasks(); });
      return el("li", { class: "task" }, [el("label", {}, [checkbox, task.text]), remove]);
    }));
  };
  function display(result: BoardResult, fictional: boolean): void {
    source.replaceChildren(el("h2", { class: "source-heading", text: result.title }), el("p", { class: "muted", text: result.subtitle }));
    const cards = result.cards.map(card => {
      const children: Node[] = [el("span", { class: "tag", text: card.label }), el("h3", { text: card.title }), el("p", { text: card.detail })];
      if (card.url) {
        try {
          const url = new URL(card.url);
          if (["https:", "http:"].includes(url.protocol)) children.push(el("a", { href: url.href, target: "_blank", rel: "noopener noreferrer", text: "Open original source ↗" }));
        } catch { /* Invalid source links are not interactive. */ }
      }
      return el("article", { class: "card" }, children);
    });
    source.append(...cards);
    if (!cards.length) source.append(el("p", { text: options.empty }));
    status.className = "status";
    status.textContent = fictional ? "Fictional example · no connected account was read. Preparation notes below are still your own." : "Source refreshed " + new Date(result.refreshedAt).toLocaleString() + ". Preparation notes stay in this workspace.";
  }
  source.append(el("h2", { text: "Your source board" }), el("p", { text: options.empty }));
  refresh.addEventListener("click", async () => {
    refresh.disabled = sample.disabled = true;
    source.replaceChildren(el("p", { text: "Loading source…" }));
    status.textContent = "Reading " + options.connector + "…";
    try { display(await api.refresh(input.value), false); }
    catch {
      source.replaceChildren(el("h2", { text: "Source unavailable" }), el("p", { text: options.setup }));
      status.className = "status error";
      status.textContent = "Could not read the source. Check the connection and permissions, then refresh. Previous source records have been cleared.";
    } finally { refresh.disabled = sample.disabled = false; }
  });
  sample.addEventListener("click", () => display(options.sample, true));
  const taskForm = el("form", { class: "task-form" }, [taskInput, el("button", { type: "submit", text: "Add" })]);
  taskForm.addEventListener("submit", event => {
    event.preventDefault();
    if (!loaded || !taskInput.value.trim()) return;
    if (preparation.tasks.length >= 50) { saveStatus.textContent = "Use up to 50 preparation tasks."; return; }
    preparation.tasks.push({ id: crypto.randomUUID(), text: taskInput.value.trim(), done: false });
    taskInput.value = ""; changed(); drawTasks();
  });
  notes.disabled = taskInput.disabled = true;
  notes.addEventListener("input", () => { printedNotes.textContent = notes.value; changed(); });
  save.addEventListener("click", async () => {
    const version = dirtyVersion;
    save.disabled = true;
    saveStatus.textContent = "Saving…";
    try {
      await api.savePreparation({ notes: notes.value, tasks: preparation.tasks.map(task => ({ ...task })) });
      savedVersion = version;
      saveStatus.textContent = version === dirtyVersion ? "Preparation saved" : "Unsaved preparation";
    } catch { saveStatus.textContent = "Could not save. Your edits are still here; try again."; }
    finally { save.disabled = false; }
  });
  window.addEventListener("beforeunload", event => { if (dirtyVersion !== savedVersion) event.preventDefault(); });
  const toolbar = el("div", { class: "toolbar" }, [options.inputType !== "none" && el("label", { for: "source-input", text: options.inputLabel }, input), refresh, sample]);
  const main = el("main", {}, [el("header", {}, [el("div", { class: "eyebrow", text: options.eyebrow }), el("h1", { text: options.title }), el("p", { class: "lede", text: options.description })]), toolbar, status,
    el("div", { class: "layout" }, [source, el("aside", { class: "panel", "aria-label": "Preparation" }, [el("h2", { text: "Make it your own" }), el("p", { class: "muted", text: "Teacher notes and tasks are saved here. They do not change the connected source." }), el("label", { for: "teacher-notes", text: "Preparation notes" }), notes, printedNotes, tasks, taskForm, save, saveStatus])]),
    el("details", { class: "setup" }, [el("summary", { text: "Connection and sharing" }), el("p", { text: options.setup }), el("p", { text: "Publish the blueprint to share the code. Each recipient connects their own resources. Keep private records out of code and public previews; workspace collaboration has separate access checks." })])]);
  document.head.append(style);
  document.body.replaceChildren(main);
  void api.getPreparation().then(value => {
    preparation = value; notes.value = printedNotes.textContent = value.notes; loaded = true;
    notes.disabled = taskInput.disabled = save.disabled = false;
    drawTasks(); saveStatus.textContent = "Preparation loaded";
  }).catch(() => { saveStatus.textContent = "Could not load preparation. Reopen this gadget before editing to protect saved notes."; });
}
