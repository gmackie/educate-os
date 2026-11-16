import { useState } from "react";
import type { RouteResponse } from "@educateos/api-client";
import { Button, InputArea, Text } from "@cloudflare/kumo";
import { useDistrictApi } from "../DistrictApi.tsx";
import { useLoad } from "../useLoad.ts";
import { Loading } from "../Loading.tsx";
import { Problem } from "../Problem.tsx";
import { describeProblem } from "../errorMessage.ts";
import { useAnnounce } from "../Announcer.tsx";

import type { TeachingOffering } from "../types.ts";

type OfferingId = TeachingOffering["offering"]["id"];
type Body = RouteResponse<"teacher.recipes">;
type Entry = Body["entries"][number];
const STATUS: Record<Entry["status"], string> = { unreviewed: "Not reviewed yet", approved: "Approved", rejected: "Rejected", withdrawn: "Withdrawn" };
const ORIGIN: Record<Entry["origin"]["kind"], string> = {
  starter: "Starter text written by the EducateOS team. It is not educator-reviewed until you approve it.",
  "starter-edited": "Starter text that a teacher edited before approving.",
  teacher: "Written by a teacher in this class.",
};

/** One recipe: the exact text students would see, the live standards check, and the teacher's decision. */
const RecipeCard = ({ offeringId, entry, onChanged }: { offeringId: OfferingId; entry: Entry; onChanged: () => void }) => {
  const api = useDistrictApi();
  const announce = useAnnounce();
  const { content } = entry;
  const [whyNow, setWhyNow] = useState(content.whyNow);
  const [studentTask, setStudentTask] = useState(content.studentTask);
  const [challenge, setChallenge] = useState(content.independentChallenge);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = whyNow !== content.whyNow || studentTask !== content.studentTask || challenge !== content.independentChallenge;
  const usable = entry.standardCheck.state === "ok";
  const decide = async (decision: "approve" | "reject" | "withdraw") => {
    setBusy(true); setError("");
    try {
      await api.call("teacher.recipeDecision", {
        params: { offeringId },
        body: {
          decision, revision: entry.revision, ...(entry.starterId === undefined ? { recipeId: entry.recipeId } : { starterId: entry.starterId }),
          ...(decision === "approve" && changed ? { content: { ...content, whyNow, studentTask, independentChallenge: challenge } } : {}),
          ...(note.trim() === "" ? {} : { note: note.trim() }),
        },
      });
      announce(decision === "approve" ? "Recipe approved for this class." : decision === "reject" ? "Recipe rejected." : "Recipe approval withdrawn.");
      onChanged();
    } catch (caught) { const problem = describeProblem(caught); setError(problem.detail ?? problem.message); }
    finally { setBusy(false); }
  };
  return <article aria-label={`${content.title} recipe`} className="flex flex-col gap-3 border-t border-kumo-line pt-3">
    <Text as="h3" variant="heading">{content.title}</Text>
    <Text>{STATUS[entry.status]}{entry.version > 0 ? ` · version ${entry.version}` : ""} · {content.standard.label} · for “{content.interest.label}”</Text>
    <Text variant="secondary">{ORIGIN[entry.origin.kind]}</Text>
    <Text variant={usable ? "secondary" : undefined} role="status">{usable ? entry.standardCheck.message : `Not usable in this class: ${entry.standardCheck.message}`}</Text>
    {entry.audit.length > 0 && <ul className="list-disc pl-5">{entry.audit.map((a) => <li key={`${a.action}:${a.at}`}>{a.action} by {a.byName} · {a.at}{a.note ? ` · ${a.note}` : ""}</li>)}</ul>}
    <details><summary>Preview what students see</summary>
      <Text>Why now: {content.whyNow}</Text>
      <Text>Practice first (suggestions, not a diagnosis): {content.prerequisites.map((p) => p.concept).join("; ")}.</Text>
      <Text>Student task: {content.studentTask}</Text>
      <ol className="list-decimal pl-5">{content.steps.map((s) => <li key={s.title}><strong>{s.title}.</strong> {s.instruction} {s.action}</li>)}</ol>
      <Text>Independent practice challenge: {content.independentChallenge}</Text>
      <Text>Your separate transfer check: {content.transfer.prompt}</Text>
      <ul className="list-disc pl-5">{content.transfer.rubric.map((r) => <li key={r}>{r}</li>)}</ul>
      <Text variant="secondary">Does not cover: {content.coverage}</Text>
      <Text variant="secondary">Offered when a learner’s own words include one of: {content.interest.anyOf.join(", ")}{content.interest.alsoRequireAnyOf.length > 0 ? `, together with one of: ${content.interest.alsoRequireAnyOf.join(", ")}` : ""}. Never offered with: {content.interest.exclude.length > 0 ? content.interest.exclude.join(", ") : "(no excluded words)"}.</Text>
    </details>
    <details><summary>Edit before approving</summary>
      <div className="flex flex-col gap-3">
        <InputArea label={`Why now for ${content.title}`} value={whyNow} onValueChange={setWhyNow} maxLength={500} />
        <InputArea label={`Student task for ${content.title}`} value={studentTask} onValueChange={setStudentTask} maxLength={1200} />
        <InputArea label={`Independent challenge for ${content.title}`} value={challenge} onValueChange={setChallenge} maxLength={800} />
        <Text variant="secondary">An edit is saved as a new version; students who already have the earlier version keep it.</Text>
      </div>
    </details>
    <InputArea label={`Note for the record about ${content.title}`} value={note} onValueChange={setNote} maxLength={300} />
    <div className="flex flex-wrap gap-2">
      <Button variant="primary" loading={busy} disabled={!usable || (entry.status === "approved" && !changed)} onClick={() => void decide("approve")}>{entry.status === "approved" ? "Approve edited version" : "Approve for this class"}</Button>
      <Button disabled={busy || entry.status === "approved" || entry.status === "rejected"} onClick={() => void decide("reject")}>Reject</Button>
      <Button disabled={busy || entry.status !== "approved"} onClick={() => void decide("withdraw")}>Withdraw approval</Button>
    </div>
    {error && <p role="alert" className="text-kumo-danger">{error}</p>}
  </article>;
};

/** Teachers decide which reviewed recipes may connect a learner's interest to a standard in this class. */
export const RecipeReview = ({ offeringId }: { offeringId: OfferingId }) => {
  const api = useDistrictApi();
  const announce = useAnnounce();
  const data = useLoad(`recipes:${offeringId}`, (client) => client.call("teacher.recipes", { params: { offeringId } }));
  const [error, setError] = useState("");
  const pause = async (body: Body) => {
    setError("");
    try {
      await api.call("teacher.recipeSettings", { params: { offeringId }, body: { revision: body.settingsRevision, paused: !body.paused } });
      announce(body.paused ? "Learning recipes resumed." : "Learning recipes paused."); data.reload();
    } catch (caught) { const problem = describeProblem(caught); setError(problem.detail ?? problem.message); }
  };
  return <section aria-label="Learning recipes" className="flex flex-col gap-3">
    <Text as="h2" variant="heading">Learning recipes</Text>
    <Text>A recipe connects a student’s interest to one approved standard with a worked example, a task and an independent check. Students only see recipes you approve, always with your name, and may skip them. Nothing here is an assignment or a grade.</Text>
    {data.status === "loading" && <Loading label="Loading recipes…" />}
    {data.status === "error" && <Problem error={data.error} onRetry={data.reload} />}
    {data.status === "ready" && <>
      <Text variant="secondary">{data.data.engaged ? "This class connects interests to standards only through the recipes you approve." : "No recipe decisions yet: this class still uses the built-in fixed connections until you approve or reject a recipe."}</Text>
      <div><Button onClick={() => void pause(data.data)}>{data.data.paused ? "Resume learning recipes" : "Pause learning recipes"}</Button>{data.data.paused && <Text> Paused: no opportunities are created from students’ goals.</Text>}</div>
      {error && <p role="alert" className="text-kumo-danger">{error}</p>}
      {data.data.entries.map((entry) => <RecipeCard key={`${entry.recipeId ?? entry.starterId}:${entry.version}:${entry.revision}`} offeringId={offeringId} entry={entry} onChanged={data.reload} />)}
    </>}
  </section>;
};
