import { Link, Surface, Text } from "@cloudflare/kumo";
import { FileTextIcon, LinkSimpleIcon, NotePencilIcon } from "@phosphor-icons/react";
import { isNotFound, useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import type { AssignedActivity, CourseModule, CourseOutline } from "../model.ts";
import { activityPath } from "../router.tsx";
import { SafeExternalLink } from "../SafeExternalLink.tsx";
import { PageText } from "./PageText.tsx";

/** One module: its pages in full, and its activities and links in the order the teacher set. */
const ModuleSection = ({ offeringId, module, outline, activities }: {
  offeringId: string;
  module: CourseModule;
  outline: CourseOutline;
  activities: readonly AssignedActivity[];
}) => (
  <Surface as="section" aria-label={module.title} className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4">
    <Text variant="heading" as="h3">{module.title}</Text>
    <ol className="flex flex-col gap-4">
      {module.items.map((item) => {
        switch (item.kind) {
          case "page": {
            const page = outline.pages.find((p) => p.id === item.pageId);
            if (page === undefined) return null;
            return (
              <li key={item.id} className="flex flex-col gap-2">
                <span className="flex items-center gap-2">
                  <FileTextIcon aria-hidden />
                  <Text variant="heading" as="h4">{page.title}</Text>
                </span>
                <PageText markdown={page.body} />
              </li>
            );
          }
          case "activity": {
            // Students reach an activity through its assignment; one not assigned to them is not shown.
            const assigned = activities.find((a) => a.assignment.activityId === item.activityId);
            if (assigned === undefined) return null;
            return (
              <li key={item.id} className="flex items-center gap-2">
                <NotePencilIcon aria-hidden />
                <Link href={activityPath(offeringId, assigned.assignment.id)}>{assigned.assignment.title}</Link>
              </li>
            );
          }
          case "link":
            return (
              <li key={item.id} className="flex items-center gap-2">
                <LinkSimpleIcon aria-hidden />
                <SafeExternalLink href={item.url}>{item.title}</SafeExternalLink>
              </li>
            );
        }
      })}
    </ol>
  </Surface>
);

/**
 * A class's modules, as its teacher published them, in order. A class with none shows nothing
 * here, so its activities stay the first thing on the page.
 */
export const CourseModules = ({ offeringId, activities }: { offeringId: string; activities: readonly AssignedActivity[] }) => {
  const [modules, reload] = useQuery(`modules:${offeringId}`, async (api) => {
    try {
      return (await api.call("student.listModules", { params: { offeringId } })).outline;
    } catch (error) {
      // A class the student has left answers not-found; there is nothing to show.
      if (isNotFound(error)) return undefined;
      throw error;
    }
  });
  if (modules.status === "loading") return null;
  if (modules.status === "error") return <ErrorState error={modules.error} title="We couldn't load this class's modules" onRetry={reload} />;
  const outline = modules.data;
  if (outline === undefined || outline.modules.length === 0) return null;
  return (
    <section aria-labelledby="modules" className="flex flex-col gap-3">
      <Text variant="heading" as="h2">
        <span id="modules">Modules</span>
      </Text>
      {outline.modules.map((module) => (
        <ModuleSection key={module.id} offeringId={offeringId} module={module} outline={outline} activities={activities} />
      ))}
    </section>
  );
};
