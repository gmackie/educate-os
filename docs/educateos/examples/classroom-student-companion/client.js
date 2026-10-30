const make = (tag, text, attrs = {}) => {
  const element = document.createElement(tag);
  if (text !== null) element.textContent = text;
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
};
document.head.append(make("style", `
  *{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,sans-serif;background:var(--color-kumo-base,#f4f6fa);color:var(--color-kumo-default,#18202b)}
  main{max-width:900px;margin:auto;padding:24px}h1{font-size:1.7rem;margin:0}h2{line-height:1.3}header{display:flex;flex-wrap:wrap;gap:12px;align-items:center}header div{flex:1}
  button,select{font:inherit;padding:10px 14px;border:1px solid currentColor;border-radius:8px;background:var(--color-kumo-base,#fff);color:inherit;max-width:100%}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}
  button:focus-visible,select:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid currentColor;outline-offset:4px}a{color:inherit;text-decoration:underline;text-underline-offset:3px}
  .panel{padding:22px;border:1px solid var(--color-kumo-line,#b8c4d2);border-radius:14px;margin:20px 0;overflow-wrap:anywhere}.instructions{white-space:pre-wrap}.muted{font-size:.87rem}.state{font-weight:700}.actions{display:flex;flex-direction:column;align-items:flex-start;gap:14px}label{display:flex;gap:10px;align-items:flex-start}input{width:20px;height:20px;flex-shrink:0}li{margin:8px 0}[hidden]{display:none!important}@media(max-width:500px){main{padding:16px}.panel{padding:16px}}
`));
const main = make("main", null);
const header = make("header", null);
const heading = make("div", null);
heading.append(make("h1", "My Classroom companion"), make("p", "Your published assignments and your own work", {class:"muted"}));
const refresh = make("button", "Refresh");
header.append(heading, refresh);
const status = make("p", "Connecting to your course…", {role:"status", "aria-live":"polite"});
const selectLabel = make("label", "Assignment ");
const select = make("select", null, {"aria-label":"Published assignment"});
selectLabel.append(select);
const content = make("section", null, {"aria-label":"Selected assignment", "aria-busy":"true"});
main.append(header, status, selectLabel, content);
document.body.replaceChildren(main);
let busy = false;
function setBusy(value) {
  busy = value;
  refresh.disabled = value;
  select.disabled = value;
  content.setAttribute("aria-busy", String(value));
  for (const control of content.querySelectorAll("input")) control.disabled = value;
  for (const control of content.querySelectorAll("button")) {
    control.disabled = value || !content.querySelector("input[type=checkbox]")?.checked;
  }
}
function appendLink(parent, title, url) {
  if (!url) { parent.append(make("span", title)); return; }
  // Provider links are displayed as links, never interpreted as markup or fetched by the gadget.
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return;
    parent.append(make("a", title, {href:parsed.href, target:"_blank", rel:"noopener noreferrer"}));
  } catch { parent.append(make("span", title)); }
}
function render(data) {
  const {assignment, submission} = data;
  const panel = make("article", null, {class:"panel"});
  panel.append(make("h2", assignment.title), make("p", assignment.description || "Open Classroom for instructions.", {class:"instructions"}));
  if (assignment.maxPoints !== undefined) panel.append(make("p", `${assignment.maxPoints} possible points`));
  if (assignment.materials.length) {
    panel.append(make("h3", "Lesson resources"));
    const list = make("ul", null);
    for (const material of assignment.materials) {
      const li = make("li", null);
      appendLink(li, material.title || material.kind, material.url);
      list.append(li);
    }
    panel.append(list);
  }
  const own = make("section", null, {class:"panel"});
  own.append(make("h2", "My submission"), make("p", submission ? submission.state.replaceAll("_", " ") : "No submission available yet", {class:"state"}));
  if (submission?.late) own.append(make("p", "Google marks this submission late."));
  if (submission?.answer) own.append(make("p", submission.answer, {class:"instructions"}));
  for (const attachment of submission?.attachments || []) {
    const p = make("p", null);
    appendLink(p, attachment.title, attachment.url);
    own.append(p);
  }
  const classroom = make("p", null);
  appendLink(classroom, "Open in Google Classroom", submission?.alternateLink || assignment.alternateLink);
  own.append(classroom, make("p", "Prepare answers and attachments in Classroom. Check returned grades there too.", {class:"muted"}));
  if (submission && ["CREATED", "RECLAIMED_BY_STUDENT"].includes(submission.state)) {
    const actions = make("div", null, {class:"actions"});
    const label = make("label", null);
    const confirm = make("input", null, {type:"checkbox"});
    label.append(confirm, make("span", "I have checked my work and want to turn in this assignment."));
    const submit = make("button", "Request turn-in approval");
    submit.disabled = true;
    confirm.addEventListener("change", () => { submit.disabled = !confirm.checked || busy; });
    submit.addEventListener("click", async () => {
      if (busy || !confirm.checked) return;
      setBusy(true);
      status.textContent = "Review the turn-in request in Approvals. Waiting for the decision and Google readback…";
      try {
        const result = await gadget.requestTurnIn(assignment.id);
        render(result);
        status.textContent = result.submission?.state === "TURNED_IN"
          ? "Google confirms that your work is turned in."
          : "Google has not confirmed turn-in. Refresh before requesting it again.";
      } catch {
        content.replaceChildren(make("p", "Turn-in was not confirmed. Refresh to check Google before trying again."));
        status.textContent = "The request may have been rejected or the connection interrupted. Your work remains in Classroom.";
      } finally { setBusy(false); }
    });
    actions.append(label, submit);
    own.append(actions);
  }
  content.replaceChildren(panel, own, make("p", `Google read at ${data.fetchedAt}`, {class:"muted"}));
}
async function load(reloadList) {
  if (busy) return;
  setBusy(true);
  content.replaceChildren(); // Clear prior private content while reconnecting or changing work.
  status.textContent = "Reading your course…";
  try {
    if (reloadList) {
      const previous = select.value;
      const data = await gadget.listAssignments();
      select.replaceChildren(...data.assignments.map((work) => make("option", work.title, {value:work.id})));
      if (data.assignments.some((work) => work.id === previous)) select.value = previous;
    }
    if (!select.value) { status.textContent = "No published assignments are available in this course."; return; }
    const data = await gadget.getAssignment(select.value);
    render(data);
    status.textContent = "Up to date with Google Classroom.";
  } catch {
    select.replaceChildren();
    status.textContent = "Unable to read your course. Check your student Google connection and enrollment, then refresh.";
  } finally {
    setBusy(false);
    const confirmation = content.querySelector("input[type=checkbox]");
    const submit = content.querySelector("button");
    if (submit && confirmation) submit.disabled = !confirmation.checked;
  }
}
refresh.addEventListener("click", () => load(true));
select.addEventListener("change", () => load(false));
await load(true);
