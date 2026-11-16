import { useState } from "react";
import { Badge, Banner, Button, Checkbox, Text } from "@cloudflare/kumo";
import { DistrictApiError, type RouteResponse } from "@educateos/api-client";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { formatMoment } from "../app/labels.ts";
import { LoadState } from "../app/LoadState.tsx";
import { errorMessage, useLoad } from "../app/useLoad.ts";

type Access = RouteResponse<"admin.guardianGuidance">;
type Row = Access["relationships"][number];
type Capability = Row["capabilities"][number];

/** What each capability lets the guardian do, as the administrator reads it and as written in the design note. */
const CAPABILITIES: { id: Capability; label: string; description: string }[] = [
  {
    id: "suggest",
    label: "Suggest topics",
    description: "The guardian may send low-stakes curiosity or hobby suggestions. A teacher reviews each one before the student sees it. Never an assignment.",
  },
  {
    id: "progress",
    label: "Progress summary",
    description: "The guardian sees only a short progress label for standards the teacher chose, for their own child. Never work, responses or chats.",
  },
];

const ACTION_LABEL = { enabled: "Turned on", changed: "Changed", revoked: "Turned off" } as const;
const CAPABILITY_LABEL: Record<Capability, string> = { suggest: "Suggest topics", progress: "Progress summary" };

/** The state in words: off, one capability, or both. */
const stateOf = (capabilities: readonly Capability[]): string =>
  capabilities.length === 0 ? "Off" : CAPABILITIES.filter((c) => capabilities.includes(c.id)).map((c) => c.label).join(" and ");

/** One relationship's opt-in: its state, the two capabilities, a save, and its history. */
const GuidanceRow = ({ row, studentName, onSaved }: { row: Row; studentName: string; onSaved: () => void }) => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const [chosen, setChosen] = useState<ReadonlySet<Capability>>(new Set(row.capabilities));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; stale: boolean }>();
  const [done, setDone] = useState<string>();
  const ended = row.status === "revoked";
  const dirty = row.capabilities.length !== chosen.size || row.capabilities.some((c) => !chosen.has(c));
  const idBase = `guidance-${row.relationshipId}`;

  const save = async () => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    const capabilities = CAPABILITIES.map((c) => c.id).filter((id) => chosen.has(id));
    try {
      await client.call("admin.setGuardianGuidance", { params: { relationshipId: row.relationshipId as never }, body: { revision: row.revision, capabilities } });
      const message = capabilities.length === 0
        ? `Learning guidance turned off for ${row.guardianDisplayName}.`
        : `Learning guidance for ${row.guardianDisplayName}: ${stateOf(capabilities)}.`;
      announce(message);
      setDone(message);
      onSaved();
    } catch (e) {
      // A conflict means another administrator changed it first: say so plainly and offer a reload.
      setError(e instanceof DistrictApiError && e.code === "conflict" ? { message: "This changed. Reload.", stale: true } : { message: errorMessage(e), stale: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-3 rounded-md border border-kumo-line p-3">
      <fieldset className="flex flex-col gap-2" aria-describedby={`${idBase}-state`} disabled={busy || ended}>
        <legend className="flex flex-wrap items-center gap-2">
          <Text bold>{row.guardianDisplayName}</Text>
          <Badge variant={row.enabled ? "info" : "neutral"}>{row.enabled ? stateOf(row.capabilities) : "Off"}</Badge>
        </legend>
        <Text id={`${idBase}-state`} variant="secondary" size="sm">
          {ended
            ? "This relationship has ended, so it cannot be given learning guidance."
            : row.inForce
              ? `Right now: ${stateOf(row.capabilities)}.`
              : `Right now: ${stateOf(row.capabilities)}. This relationship is not in force at the moment (not yet confirmed, suspended, expired or without consent), so a choice here has no effect until it is.`}
        </Text>
        {CAPABILITIES.map((capability) => (
          <div key={capability.id} className="flex flex-col gap-1">
            <Checkbox
              label={capability.label}
              checked={chosen.has(capability.id)}
              onCheckedChange={(checked) => setChosen((now) => {
                const next = new Set(now);
                if (checked === true) next.add(capability.id);
                else next.delete(capability.id);
                return next;
              })}
            />
            <div className="pl-6"><Text variant="secondary" size="sm">{capability.description}</Text></div>
          </div>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={busy || ended || !dirty} aria-label={`Save learning guidance for ${row.guardianDisplayName}`} onClick={() => void save()}>Save</Button>
        {error?.stale === true && <Button variant="secondary" size="sm" onClick={onSaved}>Reload</Button>}
      </div>
      {/* One live region per row: polite for a result, so keyboard and screen-reader users hear what happened. */}
      <div role="status" aria-live="polite" className="flex flex-col gap-1">
        {done !== undefined && <Text size="sm">{done}</Text>}
        {error !== undefined && <Banner variant="error" title="That change was not made" description={error.message} />}
      </div>
      {row.history.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm">{`History for ${row.guardianDisplayName} (${row.history.length})`}</summary>
          <ol aria-label={`Learning guidance history for ${row.guardianDisplayName} about ${studentName}`} className="mt-2 flex flex-col gap-1">
            {row.history.map((event, index) => (
              <li key={`${event.at}-${index}`}>
                <Text size="sm">
                  {`${ACTION_LABEL[event.action]}: ${event.capabilities.length === 0 ? "nothing" : event.capabilities.map((c) => CAPABILITY_LABEL[c]).join(" and ")}`}
                  {` · ${formatMoment(event.at)} · by ${event.by}`}
                </Text>
              </li>
            ))}
          </ol>
        </details>
      )}
    </li>
  );
};

/**
 * The explicit, per-relationship opt-in to learning guidance. It is a separate record from the
 * relationship's read access: nothing here changes what the guardian can already read, and a new
 * relationship starts with it off.
 */
export const GuardianGuidanceAccess = ({ studentId, studentName }: { studentId: string; studentName: string }) => {
  const access = useLoad(`guardian-guidance:${studentId}`, (client) => client.call("admin.guardianGuidance", { params: { studentId: studentId as never } }));
  return (
    <section aria-labelledby="learning-guidance" className="flex flex-col gap-2">
      <Text as="h4" variant="heading" id="learning-guidance">Learning guidance (optional)</Text>
      <Text variant="secondary">
        This is off by default and separate from what a guardian can already read about {studentName}. Turning it on for a relationship never changes that relationship. Each choice applies to one guardian, is recorded below, and can be turned off at any time.
      </Text>
      <LoadState loaded={access} what="learning guidance access" onRetry={access.reload}>
        {(data) => data.relationships.length === 0
          ? <Text variant="secondary">There are no guardian relationships to turn this on for yet.</Text>
          : (
            <ul className="flex flex-col gap-3" aria-label={`Learning guidance access for ${data.student.displayName}'s guardians`}>
              {data.relationships.map((row) => (
                // Keyed by revision so the checkboxes start again from what the district now holds.
                <GuidanceRow key={`${row.relationshipId}:${row.revision}`} row={row} studentName={data.student.displayName} onSaved={access.reload} />
              ))}
            </ul>
          )}
      </LoadState>
    </section>
  );
};
