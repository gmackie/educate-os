import { useState } from "react";
import { Badge, Button, Checkbox, Surface, Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";
import { messageFor, useApi, useQuery } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";

type Invitation = RouteResponse<"student.guidance">["invitations"][number];

const TYPE_LABEL: Record<Invitation["type"], string> = {
  "family-topic": "Family suggestion",
  "practice": "Optional practice",
  "planner-invitation": "Teacher suggestion",
};

/**
 * One suggestion. Its origin is always named, and the words "suggestion" and "not an assignment"
 * are always on it, so a student can never mistake it for required work.
 */
const InvitationCard = ({ offeringId, invitation: i, onChanged }: { offeringId: string; invitation: Invitation; onChanged: () => void }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const respond = async (decision: "accepted" | "declined") => {
    if (i.revision === undefined) return;
    setBusy(true);
    setError("");
    try {
      await api.call("student.guidanceRespond", { params: { offeringId, invitationId: i.id }, body: { revision: i.revision, decision } });
      announce(decision === "accepted" ? "You accepted this suggestion." : "You said no thanks. Nobody is told.");
      onChanged();
    } catch (caught) { setError(messageFor(caught)); }
    finally { setBusy(false); }
  };
  const titleId = `invitation-${i.id}`;
  return (
    <Surface as="article" aria-labelledby={titleId} className="flex flex-col gap-2 rounded-lg border border-kumo-hairline p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="info">{TYPE_LABEL[i.type]}</Badge>
        <Badge variant="neutral">Suggestion · not an assignment</Badge>
      </div>
      <Text as="h4" variant="heading"><span id={titleId}>{i.title}</span></Text>
      <Text variant="secondary" size="sm">{i.origin.kind === "guardian" ? `From your family: ${i.origin.name}` : `From your teacher: ${i.origin.name}`}</Text>
      {i.detail !== undefined && <p className="whitespace-pre-wrap">{i.detail}</p>}
      {i.area !== undefined && <Text variant="secondary" size="sm">{`Practice area: ${i.area}. This is not a test and has no score.`}</Text>}
      {i.type === "planner-invitation" && <Text size="sm">Open the Personalized Learning Planner on this page to see it. You can accept or skip there.</Text>}
      {i.revision !== undefined && (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy || i.decision === "accepted"} onClick={() => void respond("accepted")}>Yes, I'll try it</Button>
          <Button disabled={busy || i.decision === "declined"} onClick={() => void respond("declined")}>No thanks</Button>
          {i.decision !== "pending" && <Text size="sm" variant="secondary">{i.decision === "accepted" ? "You said yes. You can change your mind." : "You said no thanks. Nobody was told."}</Text>}
        </div>
      )}
      {error && <p role="alert" className="text-kumo-danger">{error}</p>}
    </Surface>
  );
};

/** Suggestions for the student in one class, who each came from, and the switch for family suggestions. */
export const StudentGuidance = ({ offeringId }: { offeringId: string }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [guidance, reload] = useQuery(`guidance:${offeringId}`, (client) => client.call("student.guidance", { params: { offeringId } }));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const setFamily = async (on: boolean, revision: number) => {
    setBusy(true);
    setError("");
    try {
      await api.call("student.guidancePreference", { body: { revision, guardianSuggestions: on ? "on" : "off" } });
      announce(on ? "Family suggestions are on." : "Family suggestions are off.");
      reload();
    } catch (caught) { setError(messageFor(caught)); }
    finally { setBusy(false); }
  };
  if (guidance.status === "loading") return <LoadingSkeleton label="Loading your suggestions" />;
  if (guidance.status === "error") return <ErrorState error={guidance.error} onRetry={reload} title="We couldn't load your suggestions" />;
  const { invitations, preferences, transparency } = guidance.data;
  return (
    <section aria-label="Suggestions for you" className="flex flex-col gap-4">
      <Text as="h2" variant="heading">Suggestions for you</Text>
      <Text>These are ideas, not assignments. They have no due date and never change a grade. Required work is in Activities.</Text>
      <Checkbox
        label="Show suggestions from my family"
        checked={preferences.guardianSuggestions === "on"}
        disabled={busy}
        onCheckedChange={(checked) => void setFamily(checked, preferences.revision)}
      />
      {error && <p role="alert" className="text-kumo-danger">{error}</p>}
      {invitations.length === 0
        ? <Text variant="secondary">No suggestions right now.</Text>
        : <ul className="flex flex-col gap-3">{invitations.map((i) => <li key={i.id}><InvitationCard offeringId={offeringId} invitation={i} onChanged={reload} /></li>)}</ul>}
      <details>
        <summary>Who can see what</summary>
        <ul className="list-disc pl-5">{transparency.map((line) => <li key={line}>{line}</li>)}</ul>
      </details>
    </section>
  );
};
