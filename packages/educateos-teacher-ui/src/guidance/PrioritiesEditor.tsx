import { useState } from "react";
import { Button, Input, InputArea, Select, Surface, Text } from "@cloudflare/kumo";
import type { RouteInput, RouteResponse } from "@educateos/api-client";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { describeProblem } from "../errorMessage.ts";

type Body = RouteResponse<"teacher.guidance">;
type Goal = RouteResponse<"teacher.learningGoals">["goals"][number];
type Level = "focus" | "supporting";
interface Draft { frameworkKey: string; competencyUri: string; code: string; statement: string; level: Level; startsOn: string; endsOn: string; discussionPrompt: string }

const LEVELS = { focus: "Focus", supporting: "Supporting" };

const fromAgenda = (priorities: Body["agenda"]["priorities"]): Draft[] => priorities.map((p) => ({
  frameworkKey: p.frameworkKey, competencyUri: p.competencyUri, code: p.code, statement: p.statement, level: p.level,
  startsOn: p.pacing?.startsOn ?? "", endsOn: p.pacing?.endsOn ?? "", discussionPrompt: p.discussionPrompt ?? "",
}));

/**
 * Choose which approved standards this class emphasises, with optional pacing dates and an
 * optional discussion prompt. Only standards the district approved for this course are offered; a
 * priority is a signal for the dashboard, never an assignment.
 */
export const PrioritiesEditor = ({ offeringId, agenda, goals, onSaved }: { offeringId: string; agenda: Body["agenda"]; goals: readonly Goal[]; onSaved: (body: Body) => void }) => {
  const api = useDistrictApi();
  const announce = useAnnounce();
  const [drafts, setDrafts] = useState<Draft[]>(() => fromAgenda(agenda.priorities));
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const available = goals.filter((g) => !drafts.some((d) => d.frameworkKey === g.frameworkKey && d.competencyUri === g.competencyUri));
  const patch = (index: number, change: Partial<Draft>) => setDrafts((all) => all.map((d, i) => i === index ? { ...d, ...change } : d));
  const add = () => {
    const goal = available.find((g) => `${g.frameworkKey}\u0000${g.competencyUri}` === adding);
    if (goal === undefined) return;
    setDrafts((all) => [...all, { frameworkKey: goal.frameworkKey, competencyUri: goal.competencyUri, code: goal.code, statement: goal.statement, level: "supporting", startsOn: "", endsOn: "", discussionPrompt: "" }]);
    setAdding("");
  };
  const save = async () => {
    setError("");
    if (drafts.some((d) => (d.startsOn === "") !== (d.endsOn === ""))) { setError("Give both pacing dates, or neither."); return; }
    setBusy(true);
    try {
      const priorities: RouteInput<"teacher.guidanceAgenda">["body"]["priorities"] = drafts.map((d) => ({
        frameworkKey: d.frameworkKey, competencyUri: d.competencyUri, level: d.level,
        ...(d.startsOn === "" ? {} : { pacing: { startsOn: d.startsOn, endsOn: d.endsOn } }),
        ...(d.discussionPrompt.trim() === "" ? {} : { discussionPrompt: d.discussionPrompt.trim() }),
      }));
      const body = await api.call("teacher.guidanceAgenda", { params: { offeringId: offeringId as never }, body: { revision: agenda.revision, priorities } });
      onSaved(body); setDrafts(fromAgenda(body.agenda.priorities));
      announce("Standards priorities saved. Nothing was assigned to students.");
    } catch (caught) { const problem = describeProblem(caught); setError(problem.detail ?? problem.message); }
    finally { setBusy(false); }
  };
  return (
    <section aria-labelledby="priorities-heading" className="flex flex-col gap-3">
      <Text as="h2" variant="heading"><span id="priorities-heading">Standards priorities and pacing</span></Text>
      <Text>Pick the approved standards this class is working toward. Priorities and pacing guide this dashboard only; they do not assign work. A discussion prompt, if you add one, is shown to students as an optional invitation to talk.</Text>
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {drafts.length === 0 && <Text variant="secondary">No priorities yet.</Text>}
        {drafts.map((d, index) => (
          <Surface key={`${d.frameworkKey}:${d.competencyUri}`} as="fieldset" className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4">
            <legend className="px-1 font-semibold">{d.code}</legend>
            <Text variant="secondary">{d.statement}</Text>
            <Select label={`Priority for ${d.code}`} value={d.level} items={LEVELS} onValueChange={(v) => v && patch(index, { level: v as Level })} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label={`Pacing starts for ${d.code}`} type="date" value={d.startsOn} onChange={(event) => patch(index, { startsOn: event.target.value })} />
              <Input label={`Pacing ends for ${d.code}`} type="date" value={d.endsOn} onChange={(event) => patch(index, { endsOn: event.target.value })} />
            </div>
            <InputArea label={`Optional discussion prompt for ${d.code}`} description="Plain words only: no links, email addresses or phone numbers." value={d.discussionPrompt} onValueChange={(v) => patch(index, { discussionPrompt: v })} maxLength={500} />
            <div><Button size="sm" type="button" onClick={() => setDrafts((all) => all.filter((_, i) => i !== index))} aria-label={`Remove ${d.code} from priorities`}>Remove</Button></div>
          </Surface>
        ))}
        <div className="flex flex-wrap items-end gap-2">
          <Select label="Add an approved standard" value={adding === "" ? null : adding} items={available.map((g) => ({ value: `${g.frameworkKey}\u0000${g.competencyUri}`, label: `${g.code} · ${g.statement}` }))} onValueChange={(v) => setAdding(v ?? "")} />
          <Button type="button" onClick={add} disabled={adding === ""}>Add standard</Button>
        </div>
        {goals.length === 0 && <Text variant="secondary">Your district hasn't approved learning standards for this course yet.</Text>}
        <div><Button type="submit" variant="primary" loading={busy}>Save priorities</Button></div>
        {error !== "" && <p role="alert" className="text-kumo-danger">{error}</p>}
      </form>
    </section>
  );
};
