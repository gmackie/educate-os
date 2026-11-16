import { useState } from "react";
import { Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";
import { classLabel } from "../classes/classLabel.ts";
import { Loading } from "../Loading.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import type { TeachingOffering } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { CoverageTable, type CoverageRow } from "./CoverageTable.tsx";
import { EvidenceDrillDown } from "./EvidenceDrillDown.tsx";
import { PracticeInvites } from "./PracticeInvites.tsx";
import { PrioritiesEditor } from "./PrioritiesEditor.tsx";
import { SuggestionsInbox } from "./SuggestionsInbox.tsx";

type Body = RouteResponse<"teacher.guidance">;
type Goals = RouteResponse<"teacher.learningGoals">["goals"];

/** The dashboard once loaded. It holds the latest server body, so each save refreshes every section without a reload. */
export const GuidanceView = ({ offeringId, initial, goals, students }: { offeringId: string; initial: Body; goals: Goals; students: { id: string; name: string }[] }) => {
  const [body, setBody] = useState<Body>(initial);
  const [open, setOpen] = useState<CoverageRow | undefined>(undefined);
  return (
    <div className="flex flex-col gap-8">
      <p className="m-0 rounded border border-kumo-line bg-kumo-tint p-3" data-testid="assignment-note">
        <strong>Suggestions, not assignments.</strong> {body.assignmentNote} Nothing here sets a due date, creates graded work or changes an official grade.
      </p>
      <section aria-labelledby="coverage-heading" className="flex flex-col gap-3">
        <Text as="h2" variant="heading"><span id="coverage-heading">Standards coverage</span></Text>
        <Text variant="secondary">Standards are read from the releases your district approved. A standard that is hidden, withdrawn or not in an approved release says so, and nothing is guessed about it. Opportunities and evidence by student are counted separately: being offered, accepting or sharing is never counted as mastery, and only teacher-reviewed, independent work reaches the last group.</Text>
        {body.coverage.length === 0
          ? <Text>No standards yet. Choose priorities below, or students' shared work will appear here.</Text>
          : <CoverageTable rows={body.coverage} onOpen={setOpen} />}
      </section>
      {open !== undefined && <EvidenceDrillDown key={`${open.frameworkKey}:${open.code}`} offeringId={offeringId} row={open} onClose={() => setOpen(undefined)} />}
      <PrioritiesEditor key={body.agenda.revision} offeringId={offeringId} agenda={body.agenda} goals={goals} onSaved={setBody} />
      <SuggestionsInbox offeringId={offeringId} suggestions={body.suggestions} onChanged={setBody} />
      <PracticeInvites offeringId={offeringId} students={students} practice={body.practice} onSent={setBody} />
    </div>
  );
};

/** A class's standards priorities and coverage, the family suggestions waiting for the teacher, and optional practice invitations. */
export const GuidancePage = ({ teaching }: { teaching: TeachingOffering }) => {
  const offeringId = teaching.offering.id;
  const data = useLoad(`guidance:${offeringId}`, async (client) => {
    const [body, goals, roster] = await Promise.all([
      client.call("teacher.guidance", { params: { offeringId } }),
      client.call("teacher.learningGoals", { params: { offeringId } }),
      client.call("teacher.roster", { params: { offeringId } }),
    ]);
    const students = roster.filter((r) => r.enrollment.role === "student" && r.enrollment.status === "active").map((r) => ({ id: r.enrollment.principalId, name: r.displayName }));
    return { body, goals: goals.goals, students };
  });
  return (
    <div className="flex flex-col gap-4">
      <PageHeading>{`Guidance and evidence · ${classLabel(teaching)}`}</PageHeading>
      <Text>See which standards your class has met, practiced and shown independently, choose what to emphasise, and offer optional suggestions. Private goals and chats are never shown here.</Text>
      {data.status === "loading" && <Loading label="Loading guidance…" />}
      {data.status === "error" && <Problem error={data.error} onRetry={data.reload} />}
      {data.status === "ready" && <GuidanceView offeringId={offeringId} initial={data.data.body} goals={data.data.goals} students={data.data.students} />}
    </div>
  );
};
