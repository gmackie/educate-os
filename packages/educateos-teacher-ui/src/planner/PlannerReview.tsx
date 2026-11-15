import { useState } from "react";
import { Button, Checkbox, InputArea, Select, Text } from "@cloudflare/kumo";
import type { RouteInput, RouteResponse } from "@educateos/api-client";
import { useDistrictApi } from "../DistrictApi.tsx";
import { describeProblem } from "../errorMessage.ts";
import { useAnnounce } from "../Announcer.tsx";

type Plan = RouteResponse<"teacher.planner">[number];
type Review = RouteInput<"teacher.plannerReview">["body"];
const LEVELS = { encountered: "Encountered", practiced: "Practiced", demonstrated: "Demonstrated", retained: "Retained (delayed independent check)", transferred: "Transferred (independent check in a new context)" };
const HELP = { independent: "Independent", adult: "Adult help", peer: "Peer help", ai: "AI help", unknown: "Unknown" };

/** Teacher judgment is recorded with its rationale; corrections append rather than erase history. */
export const PlannerReview = ({ plan, opportunity: o, onChanged }: { plan: Plan; opportunity: Plan["opportunities"][number]; onChanged: () => void }) => {
  const api = useDistrictApi();
  const announce = useAnnounce();
  const [level, setLevel] = useState<Review["level"]>("practiced");
  const [assistance, setAssistance] = useState<Review["assistance"]>(o.response?.assistance ?? "unknown");
  const [independentlyAssessed, setAssessed] = useState(false);
  const [decision, setDecision] = useState<Review["decision"]>("hold");
  const [rationale, setRationale] = useState("");
  const [context, setContext] = useState("");
  const [observedAt, setObservedAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const eligible = independentlyAssessed && assistance === "independent" && o.challenge?.assistance === "independent" && context.trim() !== "" && !Number.isNaN(Date.parse(observedAt)) && ["demonstrated", "retained", "transferred"].includes(level);
  const save = async () => {
    setBusy(true); setError("");
    try {
      await api.call("teacher.plannerReview", { params: { offeringId: plan.offeringId, planId: plan.id, opportunityId: o.id }, body: { revision: plan.revision, level, assistance, independentlyAssessed, decision, rationale, ...(decision === "recommend" ? { assessment: { method: level === "retained" ? "delayed-check" as const : level === "transferred" ? "new-context" as const : "independent-task" as const, context, observedAt: new Date(observedAt).toISOString() } } : {}) } });
      onChanged(); announce("Evidence review saved. No official grade was changed.");
    } catch (caught) { const problem = describeProblem(caught); setError(problem.detail ?? problem.message); }
    finally { setBusy(false); }
  };
  return <article className="flex flex-col gap-3 border-t border-kumo-line pt-3" aria-label={`${o.code} evidence review`}>
    <Text as="h3" variant="heading">{o.code} · {o.decision}</Text>
    <Text>{o.task}</Text>
    <details><summary>Standard provenance and evidence contract</summary>
      <Text>{o.framework.title} · {o.framework.publisher ?? o.framework.creator} · {o.framework.version} · release {o.releaseVersion} · catalog provenance: {o.node.provenance.source}</Text>
      <Text>{o.node.fullStatement}</Text>
      <Text>{o.code === "6.RP.A.3b" ? "Component (b), pinned to the existing 6.RP.A.3 catalog node." : `Existing ${o.node.humanCodingScheme} catalog node.`} Local identities are not canonical CASE GUIDs.</Text>
      <ul className="list-disc pl-5">{o.contract.criteria.map((c) => <li key={c.id}>{c.description}</li>)}</ul>
    </details>
    {!o.response && <Text>No response shared yet.</Text>}
    {o.response && <>
      <Text>Student-disclosed help: {o.response.assistance}</Text><p className="whitespace-pre-wrap">{o.response.text}</p>
      {o.challenge && <><Text>Separate practice challenge · {o.challenge.assistance} · prior help requests: {o.challenge.helpEvents} · {o.challenge.startedAt} to {o.challenge.sharedAt}</Text><p className="whitespace-pre-wrap">{o.challenge.text}</p><Text>Student reflection: {o.challenge.reflection}</Text></>}
      <ul>{o.reviews.map((r) => <li key={`${r.by}:${r.at}`}>{r.level} · {r.assistance} · {r.decision} · {r.rationale} · {r.at}</li>)}</ul>
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Select label="Evidence level" value={level} items={LEVELS} onValueChange={(v) => v && setLevel(v as Review["level"])} />
        <Select label="Observed assistance" value={assistance} items={HELP} onValueChange={(v) => v && setAssistance(v as Review["assistance"])} />
        <Checkbox label="I independently assessed this student's reasoning against the evidence contract" checked={independentlyAssessed} onCheckedChange={(v) => setAssessed(v === true)} />
        <Select label="Teacher decision" value={decision} items={{ hold: "Hold — no mastery recommendation", recommend: "Recommend mastery for teacher consideration" }} onValueChange={(v) => v && setDecision(v as Review["decision"])} />
        <Text variant="secondary">Only independently assessed unassisted evidence at demonstrated, retained or transferred level can support a recommendation. Generated work alone does not qualify. Record an unseen assessment task and observation after the shared independent challenge. Retention needs a prior demonstration at least seven days earlier; transfer needs a different context. You may append a correction or hold at any time.</Text>
        <InputArea label="Unseen assessment task, observed reasoning and context" value={context} onValueChange={setContext} maxLength={500} />
        <InputArea label="Assessment time (ISO 8601, with timezone)" value={observedAt} onValueChange={setObservedAt} maxLength={40} />
        <InputArea label="Review rationale and assessment conditions" value={rationale} onValueChange={setRationale} required maxLength={2000} />
        <Button type="submit" loading={busy} disabled={rationale.trim() === "" || (decision === "recommend" && !eligible)}>Save teacher review</Button>
        {error && <p role="alert" className="text-kumo-danger">{error}</p>}
      </form>
    </>}
  </article>;
};
