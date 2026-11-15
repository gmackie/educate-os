import { useState } from "react";
import { Button, InputArea, Radio, Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";
import { messageFor, useApi } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";

type Plan = RouteResponse<"student.planGoal">;
type Opportunity = Plan["opportunities"][number];
type Assistance = NonNullable<Opportunity["response"]>["assistance"];
const HELP: Assistance[] = ["independent", "adult", "peer", "ai", "unknown"];

/** One optional task and an explicit sharing boundary, independent of the learner's private goal. */
export const PlannerOpportunityCard = ({ plan, opportunity: o, onChanged }: { plan: Plan; opportunity: Opportunity; onChanged: () => void }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [text, setText] = useState("");
  const [assistance, setAssistance] = useState<Assistance>("unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const params = { offeringId: plan.offeringId, planId: plan.id, opportunityId: o.id };
  const act = async (action: "accepted" | "skipped" | "share") => {
    setBusy(true);
    setError("");
    try {
      if (action === "share") await api.call("student.plannerShare", { params, body: { revision: plan.revision, text, assistance } });
      else await api.call("student.plannerDecision", { params, body: { revision: plan.revision, decision: action } });
      announce(action === "share" ? "This response is shared with your class teachers." : `Opportunity ${action}.`);
      onChanged();
    } catch (caught) { setError(messageFor(caught)); }
    finally { setBusy(false); }
  };
  const review = o.reviews.at(-1);
  return <article aria-label={`${o.code} opportunity`} className="flex flex-col gap-3 border-t border-kumo-line pt-3">
    <Text as="h4" variant="heading">{o.code} · {o.decision}</Text>
    <Text>{o.reason}</Text><Text>{o.task}</Text>
    <Text variant="secondary">{o.priorEvidence}</Text>
    <details><summary>Approved standard and evidence contract</summary>
      <Text>{o.framework.title} · {o.framework.publisher ?? o.framework.creator} · {o.framework.version} · release {o.releaseVersion}</Text>
      <Text>{o.node.fullStatement}</Text>
      <Text variant="secondary">Catalog record: {o.node.provenance.source}. {o.code === "6.RP.A.3b" ? "Component (b) of catalog standard 6.RP.A.3." : "Catalog standard W.6.1."} Local catalog identities are not canonical CASE GUIDs.</Text>
      <ul className="list-disc pl-5">{o.contract.criteria.map((c) => <li key={c.id}>{c.description}</li>)}</ul>
      <Text>Practice may use help with disclosure. A teacher must independently assess unassisted work before recommending mastery. Generated code or artifacts alone do not establish mastery.</Text>
    </details>
    {o.response === undefined && <div className="flex gap-2">
      <Button disabled={busy || o.decision === "accepted"} onClick={() => void act("accepted")}>Accept</Button>
      <Button disabled={busy || o.decision === "skipped"} onClick={() => void act("skipped")}>Skip</Button>
    </div>}
    {o.decision === "accepted" && o.response === undefined && <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void act("share"); }}>
      <InputArea label={`Your response for ${o.code}`} value={text} onValueChange={setText} maxLength={10000} required />
      <Radio.Group legend={`Help used for ${o.code}`} value={assistance} onValueChange={(value) => setAssistance(value as Assistance)}>
        {HELP.map((value) => <Radio.Item key={value} value={value} label={value === "independent" ? "None — independently completed" : value} />)}
      </Radio.Group>
      <Text>Share only what you want your class teachers to review. Your private goal and chats are not included. A shared response is kept as evidence.</Text>
      <Button type="submit" variant="primary" loading={busy} disabled={text.trim() === ""}>Share this response with my teachers</Button>
    </form>}
    {o.response && <><Text>Shared response · help: {o.response.assistance}</Text><p className="whitespace-pre-wrap">{o.response.text}</p></>}
    {review && <Text>Teacher observation: {review.level} · help: {review.assistance} · {review.decision === "recommend" ? "mastery recommended for teacher consideration" : "no mastery recommendation"}. {review.rationale}</Text>}
    {error && <p role="alert" className="text-kumo-danger">{error}</p>}
  </article>;
};
