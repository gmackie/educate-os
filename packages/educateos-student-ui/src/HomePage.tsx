import { Empty, LinkButton, Surface, Text } from "@cloudflare/kumo";
import { ChalkboardTeacherIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { useQuery } from "./api.tsx";
import { CourseCard } from "./CourseCard.tsx";
import { groupCourses, type CourseEntry } from "./courses.ts";
import { classTitleIn } from "./labels.ts";
import { ErrorState } from "./ErrorState.tsx";
import { LoadingSkeleton } from "./LoadingSkeleton.tsx";
import type { StudentOffering } from "./model.ts";
import { PrivacyNote } from "./PrivacyNote.tsx";
import { RecentAnnouncements } from "./communication/RecentAnnouncements.tsx";
import { PhoneBanner } from "./devices/PhoneBanner.tsx";

const CourseList = ({ courses, offerings, past }: { courses: CourseEntry[]; offerings: readonly StudentOffering[]; past: boolean }) => (
  <ul className="grid gap-3 sm:grid-cols-2">
    {courses.map((course) => (
      <li key={course.offeringId}>
        <CourseCard offeringId={course.offeringId} title={classTitleIn(offerings, course.offeringId)} past={past} />
      </li>
    ))}
  </ul>
);

/** Home: this term's classes, the student's own space, and finished classes, each with who can see it. */
export const HomePage = () => {
  const [home, reload] = useQuery("home", async (api) => {
    const [me, workspaces, offerings] = await Promise.all([api.call("me.get"), api.call("student.listWorkspaces"), api.call("student.listOfferings")]);
    return { me, offerings, ...groupCourses(me, workspaces) };
  });

  if (home.status === "loading") return <LoadingSkeleton label="Loading your classes" lines={4} />;
  if (home.status === "error") return <ErrorState error={home.error} title="We couldn't load your classes" onRetry={reload} />;
  const { me, offerings, current, past } = home.data;

  return (
    <div className="flex flex-col gap-8">
      <Text variant="heading" size="lg" as="h1">
        Hi, {me.displayName}
      </Text>

      <PhoneBanner />

      <RecentAnnouncements />

      <section aria-labelledby="my-courses" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Text variant="heading" as="h2">
            <span id="my-courses">My courses</span>
          </Text>
          <PrivacyNote scope="course" />
        </div>
        {current.length === 0 ? (
          <Empty
            size="sm"
            icon={<ChalkboardTeacherIcon aria-hidden size={32} />}
            title="No classes yet"
            description="When your teacher adds you to a class, it shows up here."
          />
        ) : (
          <CourseList courses={current} offerings={offerings} past={false} />
        )}
      </section>

      <section aria-labelledby="my-space" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Text variant="heading" as="h2">
            <span id="my-space">My space</span>
          </Text>
          <PrivacyNote scope="personal" />
        </div>
        <Surface className="flex flex-col items-start gap-3 rounded-lg border border-kumo-hairline p-4">
          <Text>Notes, drafts and anything you keep from finished classes.</Text>
          <LinkButton href="/my-space" variant="secondary" icon={<LockSimpleIcon aria-hidden />}>
            Open my space
          </LinkButton>
        </Surface>
      </section>

      {past.length === 0 ? null : (
        <section aria-labelledby="past-courses" className="flex flex-col gap-3">
          <Text variant="heading" as="h2">
            <span id="past-courses">Past courses (read-only)</span>
          </Text>
          <CourseList courses={past} offerings={offerings} past />
        </section>
      )}
    </div>
  );
};
