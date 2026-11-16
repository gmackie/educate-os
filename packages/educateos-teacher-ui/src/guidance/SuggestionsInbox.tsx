import { useState } from "react";
import { Badge, Button, Surface, Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";
import { useAnnounce } from "../Announcer.tsx";
import { describeProblem } from "../errorMessage.ts";
import { useDistrictApi } from "../DistrictApi.tsx";

type Body = RouteResponse<"teacher.guidance">;
type Suggestion = Body["suggestions"][number];

const STATUS = { "awaiting-teacher": "Waiting for you", "shared": "Shared with the student", "declined": "Not shared", "withdrawn": "Withdrawn by the family" } as const;

/**
 * Guardian suggestions for this class. A suggestion reaches the student only if the teacher shares
 * it, and then only as an optional, attributed suggestion: never an assignment. Declining tells the
 * student nothing. Whether the student accepted is shown; a student's "no" never is.
 */
export const SuggestionsInbox = ({ offeringId, suggestions, onChanged }: { offeringId: string; suggestions: Suggestion[]; onChanged: (body: Body) => void }) => {
  const api = useDistrictApi();
  const announce = useAnnounce();
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState("");
  const review = async (s: Suggestion, decision: "share" | "decline") => {
    setBusy(s.id); setError("");
    try {
      const body = await api.call("teacher.guidanceSuggestionReview", { params: { offeringId: offeringId as never, suggestionId: s.id }, body: { revision: s.revision, decision } });
      onChanged(body);
      announce(decision === "share" ? "Shared as an optional suggestion. It is not an assignment." : "Suggestion declined. The student was not told.");
    } catch (caught) { const problem = describeProblem(caught); setError(problem.detail ?? problem.message); }
    finally { setBusy(""); }
  };
  return (
    <section aria-labelledby="family-suggestions" className="flex flex-col gap-3">
      <Text as="h2" variant="heading"><span id="family-suggestions">Family suggestions</span></Text>
      <Text>Families the district has opted in can suggest a low-stakes topic or hobby. Sharing one gives the student an optional suggestion that names who sent it. It is never an assignment. To require something, use Create activity.</Text>
      {error !== "" && <p role="alert" className="text-kumo-danger">{error}</p>}
      {suggestions.length === 0 && <Text variant="secondary">No family suggestions for this class.</Text>}
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {suggestions.map((s) => (
          <li key={s.id}>
            <Surface as="article" aria-label={`Suggestion for ${s.studentName}: ${s.topic}`} className="flex flex-col gap-2 rounded-lg border border-kumo-hairline p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Text as="h3" variant="heading">{s.topic}</Text>
                <Badge variant={s.status === "awaiting-teacher" ? "warning" : "neutral"}>{STATUS[s.status]}</Badge>
                <Badge variant="neutral">{s.kind === "hobby" ? "Hobby" : "Curiosity"}</Badge>
              </div>
              <Text variant="secondary">For {s.studentName} · from {s.guardianName}</Text>
              {s.note !== undefined && <p className="m-0 whitespace-pre-wrap">{s.note}</p>}
              {s.studentAccepted && <Text variant="secondary" size="sm">The student accepted this suggestion.</Text>}
              {s.status === "awaiting-teacher" && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" size="sm" loading={busy === s.id} onClick={() => void review(s, "share")} aria-label={`Share with student: ${s.topic}`}>Share with student</Button>
                  <Button size="sm" loading={busy === s.id} onClick={() => void review(s, "decline")} aria-label={`Decline: ${s.topic}`}>Decline</Button>
                </div>
              )}
            </Surface>
          </li>
        ))}
      </ul>
    </section>
  );
};
