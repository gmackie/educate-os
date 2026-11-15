import { useState } from "react";
import type { RouteResponse } from "@educateos/api-client";
import { Button, InputArea, Select, Surface, Text } from "@cloudflare/kumo";
import { useDistrictApi } from "../DistrictApi.tsx";
import { useLoad } from "../useLoad.ts";
import { Loading } from "../Loading.tsx";
import { Problem } from "../Problem.tsx";
import { describeProblem } from "../errorMessage.ts";
import { PageHeading } from "../PageHeading.tsx";
import { useAnnounce } from "../Announcer.tsx";
import type { TeachingOffering } from "../types.ts";
import { PlannerReview } from "./PlannerReview.tsx";

/** Attributed optional teacher invitations and only the evidence students explicitly shared. */
export const PlannerPage = ({ teaching }: { teaching: TeachingOffering }) => {
  const offeringId = teaching.offering.id;
  const api = useDistrictApi();
  const announce = useAnnounce();
  const data = useLoad(`planner:${offeringId}`, async (client) => {
    const [plans, roster] = await Promise.all([client.call("teacher.planner", { params: { offeringId } }), client.call("teacher.roster", { params: { offeringId } })]);
    return { plans, students: roster.filter((r) => r.enrollment.role === "student" && r.enrollment.status === "active") };
  });
  const [studentId, setStudent] = useState<RouteResponse<"teacher.planner">[number]["studentId"] | "">("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const invite = async () => {
    if (studentId === "") return;
    setBusy(true); setError("");
    try {
      await api.call("teacher.plannerInvite", { params: { offeringId }, body: { studentId, goal, skills: [] } });
      setGoal(""); data.reload(); announce("Optional teacher invitation sent.");
    } catch (caught) { const problem = describeProblem(caught); setError(problem.detail ?? problem.message); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-col gap-4">
    <PageHeading>Personalized Learning Planner</PageHeading>
    <Text>Send a transparent, optional grade 6 invitation. Students may accept or skip it. Use Create activity for required assignments.</Text>
    <Text variant="secondary">Private learner goals and chats are never shown here. Only your invitations, their decisions, and responses students explicitly share are visible to class teachers. Reviews never change official grades.</Text>
    {data.status === "loading" && <Loading label="Loading planner…" />}
    {data.status === "error" && <Problem error={data.error} onRetry={data.reload} />}
    {data.status === "ready" && <>
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void invite(); }}>
        <Select label="Student" value={studentId === "" ? null : studentId} items={data.data.students.map((s) => ({ value: s.enrollment.principalId, label: s.displayName }))} onValueChange={(v) => setStudent(v ?? "")} />
        <InputArea label="Optional invitation" description="Your name and this message are shown to the learner. Example: Explore cookie unit prices and argue for a recipe." value={goal} onValueChange={setGoal} maxLength={1000} required />
        <Button type="submit" variant="primary" loading={busy} disabled={!studentId || !goal.trim()}>Send optional teacher invitation</Button>
        {error && <p role="alert" className="text-kumo-danger">{error}</p>}
      </form>
      {data.data.plans.length === 0 && <Text>No invitations or shared planner evidence yet.</Text>}
      {data.data.plans.map((plan) => <Surface key={plan.id} className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4">
        <Text as="h2" variant="heading">{data.data.students.find((s) => s.enrollment.principalId === plan.studentId)?.displayName ?? "Student"}</Text>
        <Text>{plan.source === "teacher" ? `Optional invitation from ${plan.authorName}: ${plan.invitation}` : "Learner-shared evidence · private goal withheld"}</Text>
        {plan.opportunities.length === 0 && <Text>No approved standards match. Discuss a concrete learning opportunity with the learner.</Text>}
        {plan.opportunities.map((o) => <PlannerReview key={`${o.id}:${o.reviews.length}`} plan={plan} opportunity={o} onChanged={data.reload} />)}
      </Surface>)}
    </>}
  </div>;
};
