import { useRef, useState, type ReactNode } from "react";
import { Banner, Breadcrumbs, Empty, Surface, Text } from "@cloudflare/kumo";
import { InfoIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../api.tsx";
import { isFinished, workByStep, workSteps, workTitle } from "../courses.ts";
import { useHasDrafts } from "../drafts.ts";
import { ErrorState } from "../ErrorState.tsx";
import { classTitleIn, formatDateTime } from "../labels.ts";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { isElementaryBand, isYoungLearnerBand } from "../gradeBand.ts";
import type { AssignedActivity, ActivityStep, ArtifactView, CourseWorkspaceView } from "../model.ts";
import { PrivacyNote } from "../PrivacyNote.tsx";
import { ReadAloudButton } from "../readAloud/ReadAloudButton.tsx";
import { SpokenText } from "../readAloud/SpokenText.tsx";
import { useReadAloud } from "../readAloud/useReadAloud.ts";
import { coursePath } from "../router.tsx";
import { AskAi } from "../AskAi.tsx";
import type { ActivityWork } from "./activityWork.ts";
import { AiHelpSlot } from "./AiHelpSlot.tsx";
import { FeedbackSection } from "./FeedbackSection.tsx";
import { ResourceList } from "./ResourceList.tsx";
import { SentenceFrames } from "./SentenceFrames.tsx";
import { SubmitSection, type SubmittableWork } from "./SubmitSection.tsx";
import { WorkItem } from "./WorkItem.tsx";
import { workModeFor } from "./workMode.ts";
import { YoungActivityView } from "./YoungActivityView.tsx";

const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section aria-labelledby={id} className="flex flex-col gap-3">
    <Text variant="heading" as="h2">
      <span id={id}>{title}</span>
    </Text>
    {children}
  </section>
);

interface ActivityData {
  offeringId: string;
  courseName: string;
  entry: AssignedActivity;
  workspace: CourseWorkspaceView | undefined;
  saved: Map<string, ArtifactView>;
}

/** Instructions text with a small "Read to me" beside it, for elementary classes. */
const ReadableInstruction = ({ text, label, children }: { text: string; label: string; children?: ReactNode }) => {
  const control = useReadAloud(text, label);
  return (
    <div className="flex flex-col items-start gap-1">
      {children}
      <SpokenText control={control} />
      <ReadAloudButton control={control} />
    </div>
  );
};

const StandardActivityView = ({ offeringId, courseName, entry, work }: { offeringId: string; courseName: string; entry: AssignedActivity; work: ActivityWork }) => {
  const { assignment, activity } = entry;
  const { content } = activity;
  const steps = workSteps(content);
  // Elementary classes get read-aloud and the drawing pad; secondary classes are unchanged.
  const elementary = isElementaryBand(content.gradeBand);

  return (
    <div className="flex flex-col gap-8">
      <Breadcrumbs>
        <Breadcrumbs.Link href="/">Home</Breadcrumbs.Link>
        <Breadcrumbs.Separator />
        <Breadcrumbs.Link href={coursePath(offeringId)}>{courseName}</Breadcrumbs.Link>
        <Breadcrumbs.Separator />
        <Breadcrumbs.Current>{assignment.title}</Breadcrumbs.Current>
      </Breadcrumbs>

      <div className="flex flex-col gap-1">
        <Text variant="heading" size="lg" as="h1">
          {assignment.title}
        </Text>
        <Text variant="secondary">
          Due <time dateTime={assignment.dueAt}>{formatDateTime(assignment.dueAt)}</time>
        </Text>
        <PrivacyNote scope="course" />
      </div>
      <AskAi context={{ kind: "assignment", id: assignment.id }} />
      {work.readOnly ? (
        <Banner variant="secondary" icon={<InfoIcon weight="fill" />} title="This class has finished" description="Your work is read-only now. You can keep a copy in My space." />
      ) : null}

      <Section id="instructions" title="Instructions">
        {elementary ? <ReadableInstruction text={content.overview} label="the instructions" /> : <Text>{content.overview}</Text>}
        <ol className="flex list-decimal flex-col gap-3 pl-6">
          {content.steps.map((step) => (
            <li key={step.id}>
              {elementary ? (
                <ReadableInstruction text={step.prompt} label={step.title}>
                  <Text bold>{step.title}</Text>
                </ReadableInstruction>
              ) : (
                <>
                  <Text bold>{step.title}</Text>
                  <Text>{step.prompt}</Text>
                </>
              )}
              {step.sentenceFrames === undefined ? null : <SentenceFrames frames={step.sentenceFrames} />}
            </li>
          ))}
        </ol>
      </Section>

      <Section id="resources" title="Resources">
        <ResourceList activity={activity} />
      </Section>

      <AiHelpSlot assigned={{ assignment, activity }} />

      <Section id="my-work" title="My work">
        {steps.length === 0 ? <Text variant="secondary">There's nothing to hand in for this activity.</Text> : null}
        {steps.map((step) => (
          <Surface key={step.id} className="rounded-lg border border-kumo-hairline p-4">
            <WorkItem
              step={step}
              mode={workModeFor(step, { drawing: elementary })!}
              title={work.titleFor(step)}
              draftKey={work.draftKeyFor(step)}
              saved={work.saved.get(step.id)}
              readOnly={work.readOnly}
              ensureWorkspace={work.ensureWorkspace}
              onSaved={(view) => work.onSaved(step.id, view)}
            />
          </Surface>
        ))}
        {work.readOnly || steps.length === 0 ? null : (
          <SubmitSection assignment={assignment} work={work.submittable} unsaved={work.unsaved} onSubmitted={work.onSubmitted} />
        )}
      </Section>

      <Section id="feedback" title="Grade and feedback">
        <FeedbackSection assignmentId={assignment.id} refreshKey={work.feedbackKey} />
      </Section>
    </div>
  );
};

/**
 * The student's work on an activity, shown one of two ways: the young-learner presentation for K-2
 * classes (SCHO-323), or the standard page for everyone else.
 */
const ActivityView = ({ offeringId, courseName, entry, workspace, saved: initiallySaved }: ActivityData) => {
  const api = useApi();
  const { assignment, activity } = entry;
  const { content } = activity;
  const steps = workSteps(content);
  const draftKeyFor = (step: ActivityStep) => `${offeringId}/${assignment.id}/${step.id}`;
  const unsaved = useHasDrafts(steps.map(draftKeyFor)).some(Boolean);
  const [saved, setSaved] = useState(initiallySaved);
  const [submissions, setSubmissions] = useState(0);
  const workspaceId = useRef<Promise<string> | undefined>(workspace === undefined ? undefined : Promise.resolve(workspace.id));

  // The course workspace is opened on the first save rather than on page load, so reading an
  // activity never creates anything.
  const ensureWorkspace = () => {
    workspaceId.current ??= api.call("student.openCourseWorkspace", { params: { offeringId } }).then(
      (opened) => opened.id,
      (error: unknown) => {
        workspaceId.current = undefined;
        throw error;
      },
    );
    return workspaceId.current;
  };

  const submittable: SubmittableWork[] = steps.flatMap((step) => {
    const view = saved.get(step.id);
    return view === undefined ? [] : [{ title: step.title, artifactId: view.artifact.id, revisionId: view.head.id }];
  });

  const work: ActivityWork = {
    readOnly: isFinished(workspace),
    saved,
    titleFor: (step) => workTitle(assignment, step),
    draftKeyFor,
    ensureWorkspace,
    onSaved: (stepId, view) => setSaved((previous) => new Map(previous).set(stepId, view)),
    submittable,
    unsaved,
    feedbackKey: String(submissions),
    onSubmitted: () => setSubmissions((n) => n + 1),
  };

  return isYoungLearnerBand(content.gradeBand)
    ? <YoungActivityView offeringId={offeringId} courseName={courseName} entry={entry} work={work} />
    : <StandardActivityView offeringId={offeringId} courseName={courseName} entry={entry} work={work} />;
};

/** An activity: instructions, permitted resources, the student's work with its actions, and their grade and feedback. */
export const ActivityPage = ({ offeringId, assignmentId }: { offeringId: string; assignmentId: string }) => {
  const [page, reload] = useQuery(`activity:${offeringId}:${assignmentId}`, async (api): Promise<ActivityData | undefined> => {
    const [activities, workspaces, offerings] = await Promise.all([
      api.call("student.listActivities", { params: { offeringId } }),
      api.call("student.listWorkspaces"),
      api.call("student.listOfferings"),
    ]);
    const entry = activities.find((a) => a.assignment.id === assignmentId);
    if (entry === undefined) return undefined;
    const workspace = workspaces.find((w): w is CourseWorkspaceView => w.kind === "course" && w.offeringId === offeringId);
    const artifacts = workspace === undefined ? [] : await api.call("student.listArtifacts", { params: { workspaceId: workspace.id } });
    return { offeringId, courseName: classTitleIn(offerings, offeringId), entry, workspace, saved: workByStep(entry.assignment, entry.activity.content, artifacts) };
  });

  if (page.status === "loading") return <LoadingSkeleton label="Loading this activity" lines={6} />;
  if (page.status === "error") return <ErrorState error={page.error} title="We couldn't load this activity" onRetry={reload} />;
  if (page.data === undefined) {
    return <Empty icon={<MagnifyingGlassIcon aria-hidden size={32} />} title="We couldn't find this activity" description="It may have been removed. Go back to your class to see what's assigned." />;
  }
  return <ActivityView {...page.data} />;
};
