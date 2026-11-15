import { useState } from "react";
import { Button, Checkbox, InputArea, Surface, Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";
import { messageFor, useApi, useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { PlannerOpportunityCard } from "./PlannerOpportunityCard.tsx";

type Skill = RouteResponse<"student.planGoal">["skills"][number];
const SKILLS: Skill[] = ["teamwork", "planning", "communication"];

/** Learner-owned intent and transparent optional invitations, beside the class's assigned work. */
export const StudentPlanner = ({ offeringId }: { offeringId: string }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [plans, reload] = useQuery(`planner:${offeringId}`, (client) => client.call("student.planner", { params: { offeringId } }));
  const [goal, setGoal] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const propose = async () => {
    setBusy(true);
    setError("");
    try {
      await api.call("student.planGoal", { params: { offeringId }, body: { goal, skills } });
      setGoal("");
      reload();
      announce("Your private learning plan is saved.");
    } catch (caught) { setError(messageFor(caught)); }
    finally { setBusy(false); }
  };
  return <section aria-label="Personalized Learning Planner" className="flex flex-col gap-4">
    <Text as="h2" variant="heading">Personalized Learning Planner</Text>
    <Text>What do you want to build or explore? Grade 6 opportunities use standards your district approved. You can accept or skip them. Required assignments stay in Activities.</Text>
    <Text variant="secondary">Your goal stays private. Only a response you choose to share goes to your class teachers. This planner never reads your private chats or calls a model.</Text>
    <form onSubmit={(event) => { event.preventDefault(); void propose(); }} className="flex flex-col gap-3">
      <InputArea label="What do you want to build or explore?" placeholder="Build a Roblox Pizza Tycoon, compare cookie costs, or explore a pet project" value={goal} onValueChange={setGoal} maxLength={1000} required />
      <fieldset className="flex flex-wrap gap-3"><legend>Optional skill practice (no scoring)</legend>
        {SKILLS.map((skill) => <Checkbox key={skill} label={skill} checked={skills.includes(skill)} onCheckedChange={(checked) => setSkills(checked ? [...skills, skill] : skills.filter((s) => s !== skill))} />)}
      </fieldset>
      <Button type="submit" variant="primary" loading={busy} disabled={goal.trim() === ""}>Find optional opportunities</Button>
      {error && <p role="alert" className="text-kumo-danger">{error}</p>}
    </form>
    {plans.status === "loading" && <LoadingSkeleton label="Loading your planner" />}
    {plans.status === "error" && <ErrorState error={plans.error} onRetry={reload} title="We couldn't load your planner" />}
    {plans.status === "ready" && plans.data.map((plan) => <Surface key={plan.id} className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4">
      <Text as="h3" variant="heading">{plan.goal}</Text>
      <Text variant="secondary">{plan.source === "student" ? "Your private goal" : `Optional teacher invitation from ${plan.authorName} · not a required assignment`}</Text>
      {plan.skills.length > 0 && <Text>Optional skill practice: {plan.skills.join(", ")}</Text>}
      {plan.opportunities.length === 0 && <Text>No verified, approved match was found. Try mentioning a concrete rate, cost, sport or argument, or ask your teacher. No mastery has been inferred.</Text>}
      {plan.opportunities.map((opportunity) => <PlannerOpportunityCard key={opportunity.id} plan={plan} opportunity={opportunity} onChanged={reload} />)}
    </Surface>)}
  </section>;
};
