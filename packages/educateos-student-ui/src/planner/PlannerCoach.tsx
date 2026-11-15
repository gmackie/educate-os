import { useState } from "react";
import { Button, Checkbox, InputArea, Radio, Text } from "@cloudflare/kumo";
import type { RouteInput, RouteResponse } from "@educateos/api-client";
import { messageFor, useApi } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";

type Plan = RouteResponse<"student.planGoal">;
type CoachAction = RouteInput<"student.plannerCoach">["body"]["action"];
type Assistance = RouteInput<"student.plannerChallenge">["body"]["assistance"];

/** Help, independent practice and reflection are explicit learner choices, never automatic scores. */
export const PlannerCoach = ({ plan, opportunity: o, onChanged }: { plan: Plan; opportunity: Plan["opportunities"][number]; onChanged: () => void }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [allowAi, setAllowAi] = useState(false);
  const [text, setText] = useState("");
  const [reflection, setReflection] = useState("");
  const [assistance, setAssistance] = useState<Assistance>("unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const coach = o.coaching;
  if (!coach) return null;
  const step = coach.lesson.steps[coach.step]!;
  const params = { offeringId: plan.offeringId, planId: plan.id, opportunityId: o.id };
  const act = async (action: CoachAction | "share-challenge") => {
    setBusy(true); setError("");
    if (action === "show") setAllowAi(false);
    try {
      if (action === "share-challenge") {
        await api.call("student.plannerChallenge", { params, body: { revision: plan.revision, text, reflection, assistance } });
        announce("Your practice challenge and reflection were shared. Your teacher will assess a separate unseen task.");
      } else {
        await api.call("student.plannerCoach", { params, body: { revision: plan.revision, action, allowAi } });
        announce(action === "try" ? "Independent practice started. Coaching help is now closed for this attempt." : "Coaching step updated.");
      }
      onChanged();
    } catch (caught) { setError(messageFor(caught)); }
    finally { setBusy(false); }
  };
  return <section aria-label={`${o.code} coach`} className="flex flex-col gap-3">
    <Text as="h5" variant="heading">Your coach · {coach.mode === "instruction" ? `step ${coach.step + 1} of ${coach.lesson.steps.length}` : coach.mode}</Text>
    <Text>{coach.lesson.coverage}</Text>
    <details><summary>Before you begin</summary><ul>{coach.lesson.prerequisites.map((p) => <li key={p}>{p}</li>)}</ul><Text>If these are new, use the worked example or ask your teacher for foundational practice.</Text></details>
    {coach.mode === "instruction" && !o.challenge && <>
      <Text as="h6" variant="heading">{step.title}</Text><Text>{step.instruction}</Text><Text>Your turn: {step.action}</Text>
      <Checkbox label="Allow a district-approved AI explanation using my goal (optional)" checked={allowAi} onCheckedChange={(v) => setAllowAi(v === true)} />
      <Text variant="secondary">Only Show me how requests AI when selected; this choice resets after each request. AI explanations require district permission, guardian authorization and available budget. If unavailable, a reviewed lesson works here. There is no open chat.</Text>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void act("show")}>Show me how</Button>
        <Button disabled={busy} onClick={() => void act("hint")}>Hint</Button>
        {coach.step < coach.lesson.steps.length - 1 && <Button disabled={busy} onClick={() => void act("next")}>Next step</Button>}
        <Button disabled={busy} onClick={() => void act("try")}>Try myself</Button>
      </div>
    </>}
    {coach.guidance && <p className="whitespace-pre-wrap" role="status">{coach.guidance}</p>}
    {coach.events.length > 0 && <Text variant="secondary">Guidance: {coach.source === "governed-ai" ? "district-governed AI" : "reviewed curriculum"}.  Help requests are recorded separately from your assessment.</Text>}
    {coach.aiStatus && <p role="status">{{
      "not-requested": "AI was not requested. You can use the reviewed lesson at any time.",
      "not-wired": "Your school has not connected planner AI. Continue with the reviewed lesson.",
      "policy-denied": "AI explanations are not enabled for you here. Continue with the reviewed lesson or ask your teacher for help.",
      "budget-denied": "AI help is unavailable under your school's model or budget limits. Continue with the reviewed lesson.",
      "invalid-output": "The AI explanation could not be verified. The reviewed lesson is shown; try again later or ask your teacher.",
      "provider-unavailable": "AI help is temporarily unavailable. Continue with the reviewed lesson or try again later.",
      used: "A district-approved AI explanation is shown. It can make mistakes; check it against the lesson.",
    }[coach.aiStatus]}</p>}
    {coach.mode === "independent" && !o.challenge && <Button disabled={busy} onClick={() => void act("reflect")}>Reflect and transfer</Button>}
    {coach.mode !== "instruction" && !o.challenge && <>
      <Text>{coach.lesson.challenge}</Text><Text>{coach.lesson.transfer}</Text>
      {o.response ? <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void act("share-challenge"); }}>
        <InputArea label={`Independent practice for ${o.code}`} value={text} onValueChange={setText} required maxLength={10000} />
        <InputArea label={`Reflection for ${o.code}`} value={reflection} onValueChange={setReflection} required maxLength={2000} />
        <Radio.Group legend={`Challenge help for ${o.code}`} value={assistance} onValueChange={(v) => setAssistance(v as Assistance)}>
          {(["independent", "adult", "peer", "ai", "unknown"] as const).map((v) => <Radio.Item key={v} value={v} label={v === "independent" ? "No help on this challenge" : `${v} on this challenge`} />)}
        </Radio.Group>
        <Text>This explicitly shares the challenge, reflection, timing and help summary with your teachers. Practice does not prove mastery. Your teacher supplies an unseen test.</Text>
        <Button type="submit" disabled={busy || !text.trim() || !reflection.trim()}>Share challenge and reflection</Button>
      </form> : <Text>Share your project response below first, then share this separate practice challenge when ready.</Text>}
    </>}
    {o.challenge && <Text>Practice challenge shared · {o.challenge.assistance}. Awaiting a separate teacher assessment.</Text>}
    {error && <p role="alert" className="text-kumo-danger">{error}</p>}
  </section>;
};
