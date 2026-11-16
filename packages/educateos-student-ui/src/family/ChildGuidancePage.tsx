import { useState } from "react";
import { Badge, Button, Empty, InputArea, Radio, Surface, Text } from "@cloudflare/kumo";
import { LightbulbIcon } from "@phosphor-icons/react";
import { DistrictApiError, type RouteResponse } from "@educateos/api-client";
import { isNotFound, messageFor, useApi, useQuery } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { PageHeading } from "../PageHeading.tsx";

type Offering = RouteResponse<"guardian.guidance">["offerings"][number];
type Kind = "curiosity" | "hobby";

const STATUS_TEXT: Record<NonNullable<Offering["suggestions"]>[number]["status"], string> = {
  "awaiting-teacher": "Waiting for the teacher to review",
  "shared": "Shared with your child as an optional suggestion",
  "declined": "The teacher didn't share this one",
  "withdrawn": "You withdrew this",
};

/** A form for one class. Sending is a suggestion only: it is reviewed by the teacher and never becomes a requirement. */
const SuggestForm = ({ studentId, offering, childName, onSent }: { studentId: string; offering: Offering; childName: string; onSent: () => void }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [kind, setKind] = useState<Kind>("curiosity");
  const [topic, setTopic] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = async () => {
    setBusy(true);
    setError("");
    try {
      await api.call("guardian.guidanceSuggest", {
        params: { studentId, offeringId: offering.offeringId },
        body: { kind, topic, ...(note.trim() === "" ? {} : { note }) },
      });
      setTopic("");
      setNote("");
      announce("Your suggestion was sent to the teacher to review.");
      onSent();
    } catch (caught) {
      setError(caught instanceof DistrictApiError && (caught.code === "validation-failed")
        ? "Use plain words for the topic and note: no links, email addresses or phone numbers."
        : caught instanceof DistrictApiError && caught.code === "forbidden"
          ? "Your school hasn't turned on suggestions for this class."
          : messageFor(caught));
    } finally { setBusy(false); }
  };
  return (
    <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="flex flex-col gap-3" aria-label={`Suggest a topic for ${offering.title}`}>
      <Text as="h4" variant="heading">Suggest something to explore</Text>
      <Text variant="secondary" size="sm">{`A low-stakes idea for ${childName}, like a hobby or something they're curious about. The teacher reviews it first. It is a suggestion: it is never homework, never graded, and ${childName} can say no.`}</Text>
      <Radio.Group legend="What kind of idea is it?" value={kind} onValueChange={(value) => setKind(value as Kind)}>
        <Radio.Item value="curiosity" label="Something they're curious about" />
        <Radio.Item value="hobby" label="A hobby or interest" />
      </Radio.Group>
      <InputArea label="Topic" value={topic} onValueChange={setTopic} maxLength={120} required />
      <InputArea label="Anything the teacher should know (optional)" value={note} onValueChange={setNote} maxLength={400} />
      <Button type="submit" variant="primary" loading={busy} disabled={topic.trim() === ""}>Send to the teacher</Button>
      {error && <p role="alert" className="text-kumo-danger">{error}</p>}
    </form>
  );
};

const OwnSuggestions = ({ studentId, offering, onChanged }: { studentId: string; offering: Offering; onChanged: () => void }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [error, setError] = useState("");
  const withdraw = async (suggestionId: string) => {
    setError("");
    try {
      await api.call("guardian.guidanceWithdraw", { params: { studentId, offeringId: offering.offeringId, suggestionId } });
      announce("Suggestion withdrawn.");
      onChanged();
    } catch (caught) { setError(messageFor(caught)); }
  };
  const list = offering.suggestions ?? [];
  if (list.length === 0) return <Text variant="secondary" size="sm">You haven't sent any suggestions for this class.</Text>;
  return (
    <>
      <ul className="flex flex-col gap-2">
        {list.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
            <span><strong>{s.topic}</strong> · <span>{STATUS_TEXT[s.status]}</span></span>
            {(s.status === "awaiting-teacher" || s.status === "shared") && <Button size="sm" onClick={() => void withdraw(s.id)}>{`Withdraw "${s.topic}"`}</Button>}
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="text-kumo-danger">{error}</p>}
    </>
  );
};

/**
 * A child's learning guidance for their guardian. It exists only if the district switched it on for
 * this relationship; otherwise the page says so plainly and offers nothing. What it shows is exactly
 * what the policy engine allowed: a short progress label for standards the teacher chose, and the
 * guardian's own suggestions. Never work, responses, chats, or what the child chose to do with a suggestion.
 */
export const ChildGuidancePage = ({ studentId }: { studentId: string }) => {
  const [page, reload] = useQuery(`child-guidance:${studentId}`, (api) => api.call("guardian.guidance", { params: { studentId } }));
  if (page.status === "loading") return <LoadingSkeleton label="Loading learning guidance" lines={4} />;
  if (page.status === "error") {
    return isNotFound(page.error)
      ? <Empty title="This child isn't connected to you" description="Use My children to see the children your school has confirmed for you." />
      : <ErrorState error={page.error} title="We couldn't load this" onRetry={reload} />;
  }
  const { child, capabilities, offerings, notice } = page.data;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <PageHeading>{`${child.displayName}'s learning guidance`}</PageHeading>
        <Text variant="secondary">{notice}</Text>
      </div>
      {offerings.length === 0 ? (
        <Empty
          size="sm"
          icon={<LightbulbIcon aria-hidden size={32} />}
          title="Not turned on for your family"
          description="Your school hasn't switched on learning guidance for you. Ask your school's office if you'd like it. Nothing else about your access changes."
        />
      ) : offerings.map((offering) => (
        <Surface key={offering.offeringId} as="section" aria-label={offering.title} className="flex flex-col gap-4 rounded-lg border border-kumo-hairline p-4">
          <Text as="h2" variant="heading">{offering.title}</Text>
          {capabilities.progress && offering.progress !== undefined && (
            <section aria-label={`Progress in ${offering.title}`} className="flex flex-col gap-2">
              <Text as="h3" variant="heading">Where things stand</Text>
              <Text variant="secondary" size="sm">Only the standards the teacher chose to focus on. A short label, not a grade, and no work or conversations.</Text>
              {offering.progress.length === 0
                ? <Text variant="secondary">The teacher hasn't chosen standards to share yet.</Text>
                : <ul className="flex flex-col gap-2">{offering.progress.map((p) => (
                  <li key={p.code} className="flex flex-col gap-1">
                    <span><strong>{p.code}</strong>{p.focus ? <> <Badge variant="info">Focus</Badge></> : null}</span>
                    <span className="text-sm">{p.statement}</span>
                    <span>{p.label}</span>
                  </li>
                ))}</ul>}
            </section>
          )}
          {capabilities.suggest && offering.suggestions !== undefined && (
            <section aria-label={`Suggestions for ${offering.title}`} className="flex flex-col gap-3">
              <Text as="h3" variant="heading">Your suggestions</Text>
              <OwnSuggestions studentId={studentId} offering={offering} onChanged={reload} />
              <SuggestForm studentId={studentId} offering={offering} childName={child.displayName} onSent={reload} />
            </section>
          )}
        </Surface>
      ))}
    </div>
  );
};
