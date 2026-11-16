import { useState } from "react";
import { Badge, Button, Checkbox, InputArea, Select, Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { describeProblem } from "../errorMessage.ts";
import { PRACTICE_PROMPTS, type PracticeSkill } from "./practice.ts";

type Body = RouteResponse<"teacher.guidance">;

/**
 * Optional teamwork, planning and communication practice (CASEL). The wording is fixed, so a
 * teacher picks a skill, never a question. These invitations have no score, are not assessments,
 * ask for no reply, and are never used to describe or label a student. A student who declines is
 * not reported; one who accepts is shown only as "Accepted".
 */
export const PracticeInvites = ({ offeringId, students, practice, onSent }: { offeringId: string; students: { id: string; name: string }[]; practice: Body["practice"]; onSent: (body: Body) => void }) => {
  const api = useDistrictApi();
  const announce = useAnnounce();
  const [skill, setSkill] = useState<PracticeSkill>("teamwork");
  const [chosen, setChosen] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = async () => {
    setBusy(true); setError("");
    try {
      const body = await api.call("teacher.guidancePracticeInvite", {
        params: { offeringId: offeringId as never },
        body: { studentIds: chosen as never, skill, ...(note.trim() === "" ? {} : { note: note.trim() }) },
      });
      onSent(body); setChosen([]); setNote("");
      announce("Optional practice invitations sent. They are not assignments.");
    } catch (caught) { const problem = describeProblem(caught); setError(problem.detail ?? problem.message); }
    finally { setBusy(false); }
  };
  return (
    <section aria-labelledby="practice-heading" className="flex flex-col gap-3">
      <Text as="h2" variant="heading"><span id="practice-heading">Optional practice invitations</span></Text>
      <Text>Invite students to try teamwork, planning or communication practice. These are optional, unscored and not assessments. They never describe a student, and nothing is inferred from who accepts.</Text>
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <Select label="Practice skill" value={skill} items={{ teamwork: "Teamwork", planning: "Planning", communication: "Communication" }} onValueChange={(v) => v && setSkill(v as PracticeSkill)} />
        <Text variant="secondary" aria-live="polite">{PRACTICE_PROMPTS[skill].title} ({PRACTICE_PROMPTS[skill].area}): {PRACTICE_PROMPTS[skill].prompt}</Text>
        <fieldset className="flex flex-col gap-2 border-0 p-0">
          <legend className="font-semibold">Students to invite</legend>
          {students.map((s) => (
            <Checkbox key={s.id} label={s.name} checked={chosen.includes(s.id)} onCheckedChange={(v) => setChosen((all) => v === true ? [...all, s.id] : all.filter((id) => id !== s.id))} />
          ))}
        </fieldset>
        <InputArea label="Optional note to students" description="Plain words only. Shown with the invitation, with your name." value={note} onValueChange={setNote} maxLength={300} />
        <div><Button type="submit" variant="primary" loading={busy} disabled={chosen.length === 0}>Send optional practice invitations</Button></div>
        {error !== "" && <p role="alert" className="text-kumo-danger">{error}</p>}
      </form>
      {practice.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Practice invitations sent">
          {practice.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2">
              <span>{p.studentName}: {PRACTICE_PROMPTS[p.skill].title}</span>
              {p.accepted ? <Badge variant="info">Accepted</Badge> : <Badge variant="neutral">Invited</Badge>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
