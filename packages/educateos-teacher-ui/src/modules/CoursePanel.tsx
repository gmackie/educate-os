import { useState } from "react";
import { Badge, Banner, Button, LayerCard, Text } from "@cloudflare/kumo";
import { Books, DownloadSimple } from "@phosphor-icons/react";
import { Problem } from "../Problem.tsx";
import type { CourseInstallPlan, LibraryCourse } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { useAction } from "./useAction.ts";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const UNIT_STATUS: Record<CourseInstallPlan["units"][number]["status"], string> = {
  new: "Will be added",
  installing: "Partly added; installing finishes it",
  installed: "Added",
  exists: "Already in this class; left as it is",
};

/** What a unit adds, counted by kind, as a teacher reads it. */
const unitContents = (unit: CourseInstallPlan["units"][number]): string => {
  const count = (kind: string) => unit.items.filter((item) => item.kind === kind).length;
  return [
    plural(count("activity"), "activity", "activities"),
    count("page") === 0 ? "" : plural(count("page"), "page"),
    count("teacher-note") === 0 ? "" : `${plural(count("teacher-note"), "teacher-only note")}`,
  ].filter((part) => part !== "").join(", ");
};

const remaining = (plan: CourseInstallPlan) => plan.units.filter((unit) => unit.status === "new" || unit.status === "installing").length;

/**
 * Adding a course from the district's course library (SCHO-331): the courses an administrator
 * imported, a preview of what installing one adds to this class, and the install itself, which
 * only adds draft modules and never changes or removes what the class already has. The install
 * goes one unit per request so the teacher sees it progress, and picks up where it stopped.
 */
export const CoursePanel = ({ offeringId, onInstalled }: { offeringId: string; onInstalled: () => void }) => {
  const courses = useLoad(`course-library:${offeringId}`, (client) => client.call("teacher.libraryCourses", { params: { offeringId } }));
  const action = useAction(() => {
    onInstalled();
    courses.reload();
  });
  const [plan, setPlan] = useState<CourseInstallPlan | undefined>();

  const preview = (course: LibraryCourse) =>
    action.run("preview", async (client) => {
      const result = await client.call("teacher.previewCourseInstall", { params: { offeringId }, body: { packageId: course.packageId, version: course.version } });
      setPlan(result);
      return `${course.title} would add ${plural(remaining(result), "module")} to this class.`;
    });

  const install = (planned: CourseInstallPlan) =>
    action.run("install", async (client) => {
      let current = planned;
      // One unit a request; the server resumes from its record each time. Bounded, so a server
      // that stopped making progress can never spin the page.
      for (let attempt = 0; !current.done && attempt <= planned.units.length; attempt++) {
        current = await client.call("teacher.installCourse", { params: { offeringId }, body: { packageId: planned.packageId, version: planned.version, maxUnits: 1 } });
        setPlan(current);
      }
      const added = current.units.filter((unit) => unit.status === "installed").length;
      const kept = current.units.filter((unit) => unit.status === "exists").length;
      setPlan(undefined);
      return `Added ${current.title} as ${plural(added, "draft module")}${kept === 0 ? "" : `, leaving ${plural(kept, "module")} this class already had`}. Students see each module once you publish it.`;
    });

  const installing = action.running("install");
  const list = courses.status === "ready" ? courses.data : [];
  return (
    <LayerCard className="flex flex-col gap-4 p-4">
      <h2><Text variant="heading" as="span">Add a course</Text></h2>
      {courses.status === "loading" && <Text variant="secondary">Loading your district's courses…</Text>}
      {courses.status === "error" && <Problem error={courses.error} onRetry={courses.reload} />}
      {courses.status === "ready" && list.length === 0 && (
        <Text variant="secondary">Your district hasn't added any courses to its course library yet.</Text>
      )}
      {list.length > 0 && plan === undefined && (
        <ul aria-label="Courses" className="flex flex-col divide-y divide-kumo-line">
          {list.map((course) => (
            <li key={course.packageId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <Books aria-hidden />
                  <span className="font-medium">{course.title}</span>
                  {course.matchesClass && <Badge variant="info">Fits this class</Badge>}
                  {course.installed?.done === true && <Badge variant="success">Added</Badge>}
                </span>
                {course.summary !== undefined && <Text variant="secondary" size="sm" as="span">{course.summary}</Text>}
                <Text variant="secondary" size="sm" as="span">
                  {`${plural(course.units.length, "unit")} · ${plural(course.activities, "activity", "activities")} · from ${course.publisher.domain} · version ${course.version}`}
                </Text>
              </div>
              <div>
                <Button size="sm" variant="secondary" loading={action.running("preview")} disabled={action.busy} onClick={() => void preview(course)}>
                  {course.installed !== undefined && !course.installed.done ? `Finish adding ${course.title}` : `Preview ${course.title}`}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {plan !== undefined && (
        <section aria-label="Course preview" className="flex flex-col gap-3">
          <Text>{`${plan.title} would add ${plural(remaining(plan), "draft module")} to this class. Nothing it already has changes.`}</Text>
          <ol className="flex list-decimal flex-col gap-1 pl-6">
            {plan.units.map((unit) => (
              <li key={unit.key}>
                <span className="font-medium">{unit.title}</span>
                <Text variant="secondary" size="sm" as="span">{` · ${UNIT_STATUS[unit.status]} · ${unitContents(unit)}`}</Text>
              </li>
            ))}
          </ol>
          {plan.reusedDefinitions > 0 && (
            <Text variant="secondary" size="sm">{`${plural(plan.reusedDefinitions, "activity", "activities")} this class already has from an earlier course will be reused.`}</Text>
          )}
          <Text variant="secondary" size="sm">Teacher guides and answer keys arrive as teacher-only notes, which students never see.</Text>
          {plan.problems.length > 0 && <Banner variant="alert" title="This course can't be added yet" description={plan.problems.join(" ")} />}
          {installing && (
            <div role="status"><Text as="span">{`Adding ${plan.title}: ${plan.units.length - remaining(plan)} of ${plan.units.length} units done…`}</Text></div>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              icon={<DownloadSimple aria-hidden />}
              loading={installing}
              disabled={action.busy || plan.problems.length > 0 || plan.done}
              onClick={() => void install(plan)}
            >
              {plan.done ? "Already added" : `Add ${plural(remaining(plan), "module")}`}
            </Button>
            <Button variant="secondary" disabled={installing} onClick={() => setPlan(undefined)}>Cancel</Button>
          </div>
        </section>
      )}
      {action.state.status === "failed" && <Problem error={action.state.error} />}
    </LayerCard>
  );
};
