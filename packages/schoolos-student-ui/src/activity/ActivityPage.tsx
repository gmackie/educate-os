import { useRef, useState, type ReactNode } from "react";
import { Banner, Breadcrumbs, Empty, Surface, Text } from "@cloudflare/kumo";
import { InfoIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../api.tsx";
import { isFinished, workByStep, workSteps, workTitle } from "../courses.ts";
import { useHasDrafts } from "../drafts.ts";
import { ErrorState } from "../ErrorState.tsx";
import { courseTitle, formatDateTime } from "../labels.ts";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import type { AssignedActivity, ArtifactView, CourseWorkspaceView } from "../model.ts";
import { PrivacyNote } from "../PrivacyNote.tsx";
import { coursePath } from "../router.tsx";
import { AiHelpSlot } from "./AiHelpSlot.tsx";
import { FeedbackSection } from "./FeedbackSection.tsx";
import { ResourceList } from "./ResourceList.tsx";
import { SubmitSection, type SubmittableWork } from "./SubmitSection.tsx";
import { WorkItem } from "./WorkItem.tsx";
import { workModeFor } from "./workMode.ts";

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

const ActivityView = ({ offeringId, courseName, entry, workspace, saved: initiallySaved }: ActivityData) => {
  const api = useApi();
  const { assignment, activity } = entry;
  const { content } = activity;
  const readOnly = isFinished(workspace);
  const steps = workSteps(content);
  const draftKeys = steps.map((step) => `${offeringId}/${assignment.id}/${step.id}`);
  const unsaved = useHasDrafts(draftKeys).some(Boolean);
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

  const work: SubmittableWork[] = steps.flatMap((step) => {
    const view = saved.get(step.id);
    return view === undefined ? [] : [{ title: step.title, artifactId: view.artifact.id, revisionId: view.head.id }];
  });

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
      {readOnly ? (
        <Banner variant="secondary" icon={<InfoIcon weight="fill" />} title="This class has finished" description="Your work is read-only now. You can keep a copy in My space." />
      ) : null}

      <Section id="instructions" title="Instructions">
        <Text>{content.overview}</Text>
        <ol className="flex list-decimal flex-col gap-3 pl-6">
          {content.steps.map((step) => (
            <li key={step.id}>
              <Text bold>{step.title}</Text>
              <Text>{step.prompt}</Text>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="resources" title="Resources">
        <ResourceList content={content} />
      </Section>

      <AiHelpSlot level={activity.installation.aiHelp} />

      <Section id="my-work" title="My work">
        {steps.length === 0 ? <Text variant="secondary">There's nothing to hand in for this activity.</Text> : null}
        {steps.map((step, i) => (
          <Surface key={step.id} className="rounded-lg border border-kumo-hairline p-4">
            <WorkItem
              step={step}
              mode={workModeFor(step)!}
              title={workTitle(assignment, step)}
              draftKey={draftKeys[i]!}
              saved={saved.get(step.id)}
              readOnly={readOnly}
              ensureWorkspace={ensureWorkspace}
              onSaved={(view) => setSaved((previous) => new Map(previous).set(step.id, view))}
            />
          </Surface>
        ))}
        {readOnly || steps.length === 0 ? null : (
          <SubmitSection assignment={assignment} work={work} unsaved={unsaved} onSubmitted={() => setSubmissions((n) => n + 1)} />
        )}
      </Section>

      <Section id="feedback" title="Feedback">
        <FeedbackSection assignmentId={assignment.id} refreshKey={String(submissions)} />
      </Section>
    </div>
  );
};

/** An activity: instructions, permitted resources, the student's work with its actions, and feedback. */
export const ActivityPage = ({ offeringId, assignmentId }: { offeringId: string; assignmentId: string }) => {
  const [page, reload] = useQuery(`activity:${offeringId}:${assignmentId}`, async (api): Promise<ActivityData | undefined> => {
    const [activities, workspaces] = await Promise.all([
      api.call("student.listActivities", { params: { offeringId } }),
      api.call("student.listWorkspaces"),
    ]);
    const entry = activities.find((a) => a.assignment.id === assignmentId);
    if (entry === undefined) return undefined;
    const workspace = workspaces.find((w): w is CourseWorkspaceView => w.kind === "course" && w.offeringId === offeringId);
    const artifacts = workspace === undefined ? [] : await api.call("student.listArtifacts", { params: { workspaceId: workspace.id } });
    return { offeringId, courseName: courseTitle(activities), entry, workspace, saved: workByStep(entry.assignment, entry.activity.content, artifacts) };
  });

  if (page.status === "loading") return <LoadingSkeleton label="Loading this activity" lines={6} />;
  if (page.status === "error") return <ErrorState error={page.error} title="We couldn't load this activity" onRetry={reload} />;
  if (page.data === undefined) {
    return <Empty icon={<MagnifyingGlassIcon aria-hidden size={32} />} title="We couldn't find this activity" description="It may have been removed. Go back to your class to see what's assigned." />;
  }
  return <ActivityView {...page.data} />;
};
