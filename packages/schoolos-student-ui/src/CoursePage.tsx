import { Badge, Banner, Breadcrumbs, Empty, Link, SkeletonLine, Surface, Text } from "@cloudflare/kumo";
import { ClipboardTextIcon, InfoIcon } from "@phosphor-icons/react";
import { isNotFound, useQuery } from "./api.tsx";
import { isFinished, STATUS_LABEL, workByStep, type ActivityStatus } from "./courses.ts";
import { ErrorState } from "./ErrorState.tsx";
import { courseTitle, formatDateTime } from "./labels.ts";
import { LoadingSkeleton } from "./LoadingSkeleton.tsx";
import type { AssignedActivity } from "./model.ts";
import { PrivacyNote } from "./PrivacyNote.tsx";
import { activityPath } from "./router.tsx";
import { CourseModules } from "./modules/CourseModules.tsx";
import { CourseAnnouncements } from "./communication/CourseAnnouncements.tsx";
import { CourseDiscussions } from "./discussions/CourseDiscussions.tsx";

const STATUS_VARIANT = {
  "not-started": "neutral",
  "in-progress": "info",
  submitted: "success",
  "feedback-ready": "primary",
} as const satisfies Record<ActivityStatus, string>;

/**
 * One activity in the list, with its status. Submitted work comes from the student's submissions,
 * and "feedback ready" from whether the latest one's feedback has been released to them: the API
 * answers not-found until it has.
 */
const ActivityRow = ({ offeringId, entry, hasWork }: { offeringId: string; entry: AssignedActivity; hasWork: boolean }) => {
  const { assignment } = entry;
  const [status] = useQuery(`status:${assignment.id}:${hasWork}`, async (api): Promise<ActivityStatus> => {
    const submissions = await api.call("student.listSubmissions", { params: { assignmentId: assignment.id } });
    const latest = submissions.filter((s) => s.withdrawnAt === undefined).toSorted((a, b) => b.attempt - a.attempt)[0];
    if (latest === undefined) return hasWork ? "in-progress" : "not-started";
    try {
      await api.call("student.getFeedback", { params: { submissionId: latest.id } });
      return "feedback-ready";
    } catch (error) {
      if (isNotFound(error)) return "submitted";
      throw error;
    }
  });
  return (
    <Surface className="flex flex-col gap-2 rounded-lg border border-kumo-hairline p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1">
        <Text variant="heading" as="h3">
          <Link href={activityPath(offeringId, assignment.id)} variant="plain">
            {assignment.title}
          </Link>
        </Text>
        <Text variant="secondary" size="sm">
          Due <time dateTime={assignment.dueAt}>{formatDateTime(assignment.dueAt)}</time>
        </Text>
      </div>
      {status.status === "ready" ? (
        <Badge variant={STATUS_VARIANT[status.data]}>{STATUS_LABEL[status.data]}</Badge>
      ) : status.status === "loading" ? (
        <SkeletonLine minWidth={20} maxWidth={30} />
      ) : null}
    </Surface>
  );
};

/** A class: its activities in due-date order, each with its due date and status. */
export const CoursePage = ({ offeringId }: { offeringId: string }) => {
  const [course, reload] = useQuery(`course:${offeringId}`, async (api) => {
    const [activities, workspaces] = await Promise.all([
      api.call("student.listActivities", { params: { offeringId } }),
      api.call("student.listWorkspaces"),
    ]);
    const workspace = workspaces.find((w) => w.kind === "course" && w.offeringId === offeringId);
    const artifacts = workspace === undefined ? [] : await api.call("student.listArtifacts", { params: { workspaceId: workspace.id } });
    return { activities: activities.toSorted((a, b) => a.assignment.dueAt.localeCompare(b.assignment.dueAt)), workspace, artifacts };
  });

  if (course.status === "loading") return <LoadingSkeleton label="Loading this class" lines={4} />;
  if (course.status === "error") return <ErrorState error={course.error} title="We couldn't load this class" onRetry={reload} />;
  const { activities, workspace, artifacts } = course.data;
  const title = courseTitle(activities);

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs>
        <Breadcrumbs.Link href="/">Home</Breadcrumbs.Link>
        <Breadcrumbs.Separator />
        <Breadcrumbs.Current>{title}</Breadcrumbs.Current>
      </Breadcrumbs>
      <div className="flex flex-col gap-1">
        <Text variant="heading" size="lg" as="h1">
          {title}
        </Text>
        <PrivacyNote scope="course" />
      </div>
      {isFinished(workspace) ? (
        <Banner
          variant="secondary"
          icon={<InfoIcon weight="fill" />}
          title="This class has finished"
          description="You can look back at your work. To keep a copy of something, use My space."
        />
      ) : null}
      <CourseAnnouncements offeringId={offeringId} />
      <CourseModules offeringId={offeringId} activities={activities} />
      <CourseDiscussions offeringId={offeringId} />
      <section aria-labelledby="activities" className="flex flex-col gap-3">
        <Text variant="heading" as="h2">
          <span id="activities">Activities</span>
        </Text>
        {activities.length === 0 ? (
          <Empty size="sm" icon={<ClipboardTextIcon aria-hidden size={32} />} title="No activities yet" description="Your teacher hasn't assigned anything in this class yet." />
        ) : (
          <ul className="flex flex-col gap-3">
            {activities.map((entry) => (
              <li key={entry.assignment.id}>
                <ActivityRow offeringId={offeringId} entry={entry} hasWork={workByStep(entry.assignment, entry.activity.content, artifacts).size > 0} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
