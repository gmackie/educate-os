import { useEffect } from "react";
import { Badge, Empty, Link, Surface, Text } from "@cloudflare/kumo";
import { ChalkboardTeacherIcon, EyeIcon } from "@phosphor-icons/react";
import type { RouteResponse } from "@educateos/api-client";
import { isNotFound, useQuery } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { childCoursePath } from "../router.tsx";
import { ChildSwitcher } from "./ChildSwitcher.tsx";

/** One of a child's classes. */
type ChildClass = RouteResponse<"guardian.childOfferings">[number];

/** A class's name: its course, and the section when there is one. */
export const classTitle = ({ course, offering }: Pick<ChildClass, "course" | "offering">): string =>
  offering.sectionName === undefined ? course.title : `${course.title} · ${offering.sectionName}`;

/** What a guardian sees, and what they never see, in words a family reads. */
export const FamilyPrivacyNote = ({ childName }: { childName: string }) => (
  <p className="flex items-center gap-2 text-sm text-kumo-subtle">
    <EyeIcon aria-hidden size={16} />
    {`You see what ${childName}'s teachers have shared with ${childName}. You never see ${childName}'s own work or personal space.`}
  </p>
);

const ClassList = ({ studentId, classes, past }: { studentId: string; classes: readonly ChildClass[]; past: boolean }) => (
  <ul className="grid gap-3 sm:grid-cols-2">
    {classes.map((entry) => (
      <li key={entry.offering.id}>
        <Surface className="flex h-full flex-col gap-2 rounded-lg border border-kumo-hairline p-4">
          <Text variant="heading" as="h3">
            <Link href={childCoursePath(studentId, entry.offering.id)} variant="plain">{classTitle(entry)}</Link>
          </Text>
          <div className="flex flex-wrap items-center gap-2">
            <Text variant="secondary" size="sm">{entry.term.name}</Text>
            {past ? <Badge variant="neutral">Finished</Badge> : null}
          </div>
        </Surface>
      </li>
    ))}
  </ul>
);

/** One child's classes, this term's and finished ones, with a switcher to the guardian's other children. */
export const ChildPage = ({ studentId }: { studentId: string }) => {
  const announce = useAnnounce();
  const [page, reload] = useQuery(`child:${studentId}`, async (api) => {
    const [children, classes] = await Promise.all([
      api.call("guardian.listChildren"),
      api.call("guardian.childOfferings", { params: { studentId } }),
    ]);
    return { children, classes, child: children.find((c) => c.studentPrincipalId === studentId) };
  });

  // Switching children replaces the page's content without moving focus, so say whose it is now.
  const shown = page.status === "ready" ? page.data.child?.displayName : undefined;
  useEffect(() => {
    if (shown !== undefined) announce(`Showing ${shown}'s classes`);
    // `announce` is a new function on every render of the provider; the child shown is what changed.
  }, [shown]);

  if (page.status === "loading") return <LoadingSkeleton label="Loading classes" lines={4} />;
  if (page.status === "error") {
    return isNotFound(page.error)
      ? <Empty title="This child isn't connected to you" description="Use My children to see the children your school has confirmed for you." />
      : <ErrorState error={page.error} title="We couldn't load these classes" onRetry={reload} />;
  }
  const { children, classes, child } = page.data;
  if (child === undefined) return <Empty title="This child isn't connected to you" description="Use My children to see the children your school has confirmed for you." />;
  const current = classes.filter((c) => c.term.state !== "completed");
  const past = classes.filter((c) => c.term.state === "completed");

  return (
    <div className="flex flex-col gap-8">
      <ChildSwitcher family={children} currentId={studentId} />
      <div className="flex flex-col gap-1">
        <Text variant="heading" size="lg" as="h1">{`${child.displayName}'s classes`}</Text>
        <FamilyPrivacyNote childName={child.displayName} />
      </div>
      <section aria-labelledby="current-classes" className="flex flex-col gap-3">
        <Text variant="heading" as="h2"><span id="current-classes">This term</span></Text>
        {current.length === 0 ? (
          <Empty size="sm" icon={<ChalkboardTeacherIcon aria-hidden size={32} />} title="No classes this term" description={`When ${child.displayName} is added to a class, it shows up here.`} />
        ) : (
          <ClassList studentId={studentId} classes={current} past={false} />
        )}
      </section>
      {past.length === 0 ? null : (
        <section aria-labelledby="past-classes" className="flex flex-col gap-3">
          <Text variant="heading" as="h2"><span id="past-classes">Finished classes</span></Text>
          <ClassList studentId={studentId} classes={past} past />
        </section>
      )}
    </div>
  );
};
