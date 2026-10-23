import { Empty } from "@cloudflare/kumo";
import { Question } from "@phosphor-icons/react";
import { CreateActivityPage } from "../activities/CreateActivityPage.tsx";
import { GradebookPage } from "../gradebook/GradebookPage.tsx";
import { AnnouncementsPage } from "../announcements/AnnouncementsPage.tsx";
import { DiscussionsPage } from "../discussions/DiscussionsPage.tsx";
import { Loading } from "../Loading.tsx";
import { ModulesPage } from "../modules/ModulesPage.tsx";
import { Problem } from "../Problem.tsx";
import { ResourceReviewPage } from "../resources/ResourceReviewPage.tsx";
import { ResourcesPage } from "../resources/ResourcesPage.tsx";
import { CLASS_SECTIONS, routeHref, type Route } from "../route.ts";
import { RosterPage } from "../roster/RosterPage.tsx";
import { SubmissionReviewPage } from "../submissions/SubmissionReviewPage.tsx";
import { SubmissionsPage } from "../submissions/SubmissionsPage.tsx";
import type { TeachingOffering } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { classLabel } from "./classLabel.ts";

type ClassRoute = Exclude<Route, { screen: "classes" }>;

const sectionOf = (route: ClassRoute): (typeof CLASS_SECTIONS)[number]["screen"] => {
  switch (route.screen) {
    case "resource":
      return "resources";
    case "review":
      return "submissions";
    default:
      return route.screen;
  }
};

/** One class: where the teacher is, the class's sections, and the section the URL names. */
export const ClassPage = ({ route }: { route: ClassRoute }) => {
  const classes = useLoad("classes", (client) => client.call("teacher.listOfferings"));
  if (classes.status === "loading") return <Loading label="Opening your class…" />;
  if (classes.status === "error") return <Problem error={classes.error} onRetry={classes.reload} />;
  const teaching = classes.data.find((c) => c.offering.id === route.offeringId);
  if (teaching === undefined) {
    return (
      <Empty
        icon={<Question size={32} aria-hidden />}
        title="This class isn't one of yours"
        description="Only the teachers of a class can open it."
        contents={<a href={routeHref({ screen: "classes" })}>Back to my classes</a>}
      />
    );
  }
  const current = sectionOf(route);
  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-2 text-sm">
          <li><a href={routeHref({ screen: "classes" })}>My classes</a></li>
          <li aria-hidden>/</li>
          <li aria-current="page">{classLabel(teaching)}</li>
        </ol>
      </nav>
      <nav aria-label="Class sections">
        <ul className="flex flex-wrap gap-1 border-b border-kumo-line">
          {CLASS_SECTIONS.map((section) => (
            <li key={section.screen}>
              <a
                href={routeHref({ screen: section.screen, offeringId: teaching.offering.id })}
                aria-current={section.screen === current ? "page" : undefined}
                className="-mb-px block rounded-t border-b-2 border-transparent px-3 py-2 text-kumo-subtle no-underline focus-visible:ring-2 focus-visible:ring-kumo-brand aria-[current=page]:border-kumo-brand aria-[current=page]:text-kumo-default"
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <ClassSection route={route} teaching={teaching} />
    </div>
  );
};

const ClassSection = ({ route, teaching }: { route: ClassRoute; teaching: TeachingOffering }) => {
  switch (route.screen) {
    case "roster":
      return <RosterPage teaching={teaching} />;
    case "modules":
      return <ModulesPage teaching={teaching} />;
    case "resources":
      return <ResourcesPage teaching={teaching} />;
    case "resource":
      return <ResourceReviewPage teaching={teaching} itemId={route.itemId} />;
    case "create":
      return <CreateActivityPage teaching={teaching} />;
    case "submissions":
      return <SubmissionsPage teaching={teaching} {...(route.assignmentId === undefined ? {} : { assignmentId: route.assignmentId })} />;
    case "review":
      return <SubmissionReviewPage teaching={teaching} assignmentId={route.assignmentId} submissionId={route.submissionId} />;
    // Gradebook (SCHO-187)
    case "gradebook":
      return <GradebookPage teaching={teaching} />;
    case "announcements":
      return <AnnouncementsPage teaching={teaching} />;
    case "discussions":
      return <DiscussionsPage teaching={teaching} />;
  }
};
