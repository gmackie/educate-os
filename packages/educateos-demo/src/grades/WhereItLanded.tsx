import { useEffect, useState, useSyncExternalStore } from "react";
import { Badge, Button, Collapsible, LayerCard, Radio, Text } from "@cloudflare/kumo";
import type { DemoGradebooks, DeliveredGrade, GradeClass, GradeEvent, GradeRouteKind } from "./types.ts";

/** What the demo says about LMS Connect wherever it appears. */
export const LMS_CONNECT_CAVEAT = "Built to Clever's published v3.1 API; not tested against Clever.";

const ROUTE_LABELS: Record<GradeRouteKind, string> = {
  "google-classroom": "Post to Google Classroom directly",
  "clever-lms-connect": "Post through Clever LMS Connect",
};

/** Where a delivered grade is now, as its gradebook holds it. */
const destination = ({ landed }: DeliveredGrade): string => landed.via === "google-classroom"
  ? `Google Classroom course ${landed.courseName} (${landed.courseId}), coursework “${landed.courseWorkTitle}” (${landed.courseWorkId}): assignedGrade ${landed.assignedGrade ?? "none"} of ${landed.maxPoints ?? "?"}`
  : `Clever section ${landed.sectionName} (${landed.sectionId}), assignment “${landed.assignmentTitle}” (${landed.assignmentId}): grade_points ${landed.gradePoints ?? "none"} of ${landed.pointsPossible ?? "?"}`;

/** One line on an attempt, for the live region. */
const announcement = (event: GradeEvent): string => {
  switch (event.outcome) {
    case "posted": return `Sent ${event.studentName}'s grade to ${event.via === "google-classroom" ? "Google Classroom" : "Clever LMS Connect"}.`;
    case "already-posted": return `${event.studentName}'s grade was already sent, so nothing was sent again.`;
    case "refused": return `Refused: ${event.reason}`;
  }
};

/**
 * The teacher's view of grade passback in the demo: each class's route, chosen here, and every
 * grade the passback gate sent or refused, with what the gradebook it went to now holds.
 */
export const WhereItLanded = ({ grades }: { grades: DemoGradebooks }) => {
  const events = useSyncExternalStore(grades.subscribe, grades.events);
  const [classes, setClasses] = useState<readonly GradeClass[]>();
  const [busy, setBusy] = useState<string>();

  useEffect(() => {
    let live = true;
    const load = () => void grades.classes().then((loaded) => live && setClasses(loaded));
    load();
    const unsubscribe = grades.subscribe((event) => {
      if (event === undefined) load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [grades]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy(undefined);
    }
  };
  const routeOf = new Map(classes?.map((c) => [c.offeringId, c.route]));
  const sent = events.filter((e) => e.outcome !== "refused").length;
  const refused = events.length - sent;
  const last = events.at(-1);

  return (
    <div className="px-4 pt-4">
      <LayerCard className="p-4">
        <Collapsible.Root>
          <Collapsible.DefaultTrigger>
            {`Where grades land${events.length === 0 ? "" : ` (${sent} sent, ${refused} refused)`}`}
          </Collapsible.DefaultTrigger>
          <Collapsible.DefaultPanel>
            <div className="flex flex-col gap-4 pt-2">
              <Text variant="secondary">
                When you approve a grade below, EducateOS's passback gate sends it to the class's gradebook, here a simulated Google Classroom or the LMS behind a simulated Clever district. Choose how each class's grades go.
              </Text>
              <section aria-labelledby="grade-routes" className="flex flex-col gap-3">
                <h3 id="grade-routes"><Text variant="heading" as="span">Each class's route</Text></h3>
                {classes === undefined && <Text variant="secondary">Loading classes…</Text>}
                {classes?.length === 0 && <Text variant="secondary">No classes yet: the district's Clever roster hasn't synced.</Text>}
                {classes?.map((c) => (
                  <div key={c.offeringId} className="flex flex-col gap-2 rounded border border-kumo-line p-3">
                    <Radio.Group
                      legend={`${c.title} (${c.teachers.join(", ")})`}
                      value={c.route}
                      onValueChange={(route) => grades.setRoute(c.offeringId, route as GradeRouteKind)}
                      description={c.route === "clever-lms-connect" ? `Clever LMS Connect: ${LMS_CONNECT_CAVEAT}` : undefined}
                    >
                      <Radio.Item label={ROUTE_LABELS["google-classroom"]} value="google-classroom" />
                      <Radio.Item label={ROUTE_LABELS["clever-lms-connect"]} value="clever-lms-connect" />
                    </Radio.Group>
                    <div>
                      <Button size="sm" loading={busy === `unapproved:${c.offeringId}`} onClick={() => void run(`unapproved:${c.offeringId}`, () => grades.tryUnapproved(c.offeringId))}>
                        {`Try sending an unapproved grade in ${c.title}`}
                      </Button>
                    </div>
                  </div>
                ))}
              </section>
              <section aria-labelledby="grades-landed" className="flex flex-col gap-3">
                <h3 id="grades-landed"><Text variant="heading" as="span">Where it landed</Text></h3>
                <p role="status" className="sr-only">{last === undefined ? "" : announcement(last)}</p>
                {events.length === 0 ? (
                  <Text variant="secondary">Nothing sent yet. Grade a submission and approve the grade.</Text>
                ) : (
                  <ol className="flex flex-col gap-2">
                    {events.toReversed().map((event) => (
                      <li key={event.id} data-grade-event={event.id} data-outcome={event.outcome} className="flex flex-col gap-1 rounded border border-kumo-line p-3">
                        <p className="flex flex-wrap items-center gap-2">
                          {event.outcome === "refused"
                            ? <Badge variant="error">Refused</Badge>
                            : <Badge variant="success">{event.outcome === "posted" ? "Sent" : "Already sent"}</Badge>}
                          <Text bold as="span">{`${event.studentName}: ${event.scoreGiven} out of ${event.scoreMaximum}`}</Text>
                          <Text variant="secondary" as="span">{`${event.assignmentTitle}, ${event.className} (grade version ${event.gradeVersion})`}</Text>
                        </p>
                        {event.outcome === "refused" ? (
                          <Text>{`${event.reason} Nothing was written to any gradebook. (${event.code})`}</Text>
                        ) : (
                          <>
                            <Text>{event.outcome === "already-posted" ? `This version was already sent, so nothing was sent again. It stands at ${destination(event)}.` : `Landed in ${destination(event)}.`}</Text>
                            {event.via === "clever-lms-connect" && <Text variant="secondary" size="sm">{`Clever LMS Connect: ${LMS_CONNECT_CAVEAT}`}</Text>}
                            {routeOf.get(event.offeringId) === event.via && (
                              <div>
                                <Button size="sm" variant="ghost" loading={busy === `resend:${event.id}`} onClick={() => void run(`resend:${event.id}`, () => grades.resend(event.id))}>
                                  Send again
                                </Button>
                              </div>
                            )}
                          </>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </Collapsible.DefaultPanel>
        </Collapsible.Root>
      </LayerCard>
    </div>
  );
};
