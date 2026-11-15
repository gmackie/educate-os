import { useState } from "react";
import { Badge, Banner, Button, LayerCard, Text } from "@cloudflare/kumo";
import { Books, DownloadSimple } from "@phosphor-icons/react";
import { Problem } from "../Problem.tsx";
import type { CourseInstallPlan, CourseIntentDraft, CourseIntentDraftRecord, LibraryCourse } from "../types.ts";
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
  const [suggestion, setSuggestion] = useState<CourseIntentDraft | undefined>();
  const [drafts, setDrafts] = useState<CourseIntentDraftRecord[] | undefined>();
  const [selectedGoals, setSelectedGoals] = useState<string[]>([]);
  const [selectedStrategies, setSelectedStrategies] = useState<string[]>([]);
  const toggle = (values: string[], id: string, checked: boolean) =>
    checked ? [...values.filter((x) => x !== id), id] : values.filter((x) => x !== id);
  const intentAvailability = useLoad(`course-ai:${offeringId}`, (client) => client.call("teacher.courseIntentAvailability", { params: { offeringId } }));

  const preview = (course: LibraryCourse) =>
    action.run("preview", async (client) => {
      const result = await client.call("teacher.previewCourseInstall", { params: { offeringId }, body: { packageId: course.packageId, version: course.version } });
      setSuggestion(undefined);
      setDrafts(undefined);
      setPlan(result);
      return `${course.title} would add ${plural(remaining(result), "module")} to this class.`;
    });

  const suggestIntent = (planned: CourseInstallPlan, unitKey: string) =>
    action.run("suggest-intent", async (client) => {
      const draft = await client.call("teacher.suggestCourseIntent", {
        params: { offeringId },
        body: { packageId: planned.packageId, version: planned.version, unitKey, goal: "low-equipment", requestKey: crypto.randomUUID() },
      });
      setSuggestion(draft);
      setSelectedGoals([]);
      setSelectedStrategies([]);
      setDrafts(undefined);
      return "Saved a private AI suggestion for your review. Nothing has been published or installed.";
    });

  const showDrafts = () =>
    action.run("draft-list", async (client) => {
      const previous = await client.call("teacher.listCourseIntentDrafts", { params: { offeringId } });
      setPlan(undefined);
      setSuggestion(undefined);
      setDrafts(previous);
      return previous.length + " private curriculum drafts for this teacher.";
    });

  const reviewSuggestion = (draft: CourseIntentDraft, choice: "review" | "discard") =>
    action.run("draft-review", async (client) => {
      const next = await client.call("teacher.reviewCourseIntentDraft", {
        params: { offeringId, draftId: draft.draftId },
        body: choice === "review"
          ? { action: "review", expectedRevision: draft.revision,
              selection: { goalIds: selectedGoals, strategyIds: selectedStrategies } }
          : { action: "discard", expectedRevision: draft.revision },
      });
      if (next.status === "discarded") {
        setSuggestion(undefined);
        return "Draft discarded from current planning. Its historical audit revisions remain within the district.";
      }
      setSuggestion({ ...draft, revision: next.revision, status: "reviewed" });
      return "Selected recommendations saved as private, reviewed planning notes. No lesson was changed.";
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
      <div className="flex items-center justify-between gap-2">
        <h2><Text variant="heading" as="span">Add a course</Text></h2>
        <Button size="sm" variant="secondary" disabled={action.busy}
          loading={action.running("draft-list")} onClick={() => void showDrafts()}>
          My AI drafts
        </Button>
      </div>
      {courses.status === "loading" && <Text variant="secondary">Loading your district's courses…</Text>}
      {courses.status === "error" && <Problem error={courses.error} onRetry={courses.reload} />}
      {courses.status === "ready" && list.length === 0 && (
        <Text variant="secondary">Your district hasn't added any courses to its course library yet.</Text>
      )}
      {list.length > 0 && plan === undefined && drafts === undefined && suggestion === undefined && (
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
                {intentAvailability.status === "ready" && intentAvailability.data.available && (
                  <div>
                    <Button size="sm" variant="secondary" loading={action.running("suggest-intent")}
                      disabled={action.busy} onClick={() => void suggestIntent(plan, unit.key)}>
                      Suggest low-equipment adaptation (AI)
                    </Button>
                  </div>
                )}
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
      {drafts !== undefined && (
        <section aria-label="My private course intent drafts" className="flex flex-col gap-3">
          <h3><Text variant="heading" as="span">My AI planning drafts</Text></h3>
          <Banner title="District-private planning history"
            description="These records contain model suggestions, not approved lessons. Reviewing them does not alter the course or publish anything." />
          {drafts.length === 0 && <Text variant="secondary">No suggestions have been saved yet.</Text>}
          <ul className="flex flex-col divide-y divide-kumo-line">
            {drafts.map((draft) => (
              <li key={draft.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="flex flex-col gap-1">
                  <span className="font-medium">{draft.source.packageId + " · " + draft.source.unitKey}</span>
                  <Text size="sm" variant="secondary" as="span">
                    {draft.status.replaceAll("-", " ") + " · " + new Date(draft.updatedAt).toLocaleString()}
                  </Text>
                  {draft.selection !== undefined && (
                    <Text size="sm" variant="secondary" as="span">
                      {draft.selection.goalIds.length + " selected goals, " + draft.selection.strategyIds.length + " strategies"}
                    </Text>
                  )}
                </div>
                {(draft.status === "proposed" || draft.status === "reviewed") && draft.result !== undefined && (
                  <Button variant="secondary" size="sm" onClick={() => {
                    setSuggestion({ ...draft.result!, draftId: draft.id, revision: draft.revision, status: draft.status as "proposed" | "reviewed" });
                    setSelectedGoals(draft.selection?.goalIds ?? []);
                    setSelectedStrategies(draft.selection?.strategyIds ?? []);
                    setDrafts(undefined);
                  }}>View</Button>
                )}
              </li>
            ))}
          </ul>
          <div><Button variant="secondary" onClick={() => setDrafts(undefined)}>Back to courses</Button></div>
        </section>
      )}
      {suggestion !== undefined && (
        <section aria-label="Private AI course intent draft" className="flex flex-col gap-3">
          <h3><Text variant="heading" as="span">
            {suggestion.status === "reviewed" ? "Teacher-reviewed planning notes" : "Private suggested adaptation"}
          </Text></h3>
          <Banner title={suggestion.status === "reviewed" ? "Planning notes saved" : "Draft — not approved"}
            description="These notes are private to this teacher and class. They have not been published, assigned, or applied to an active lesson." />
          <Text size="sm" variant="secondary">
            {"Source " + suggestion.source.packageId + " · " + suggestion.source.version +
              " · " + suggestion.goal.replaceAll("-", " ")}
          </Text>
          <Text size="sm" variant="secondary">
            {"Estimated model cost $" + (Number(suggestion.actualUsdNano) / 1e9).toFixed(6) +
              " · draft revision " + suggestion.revision}
          </Text>
          <div className="flex flex-col gap-2">
            <Text>Suggested learning goals</Text>
            {suggestion.intent.learningGoals.map((goal) => (
              <label key={goal.id} className="flex items-start gap-2">
                <input type="checkbox" checked={selectedGoals.includes(goal.id)}
                  disabled={suggestion.status === "reviewed"}
                  onChange={(e) => setSelectedGoals((v) => toggle(v, goal.id, e.target.checked))} />
                <span>{goal.statement}</span>
              </label>
            ))}
            <Text>Suggested teaching strategies</Text>
            {suggestion.intent.strategies.map((strategy) => (
              <label key={strategy.id} className="flex items-start gap-2">
                <input type="checkbox" checked={selectedStrategies.includes(strategy.id)}
                  disabled={suggestion.status === "reviewed"}
                  onChange={(e) => setSelectedStrategies((v) => toggle(v, strategy.id, e.target.checked))} />
                <span>{strategy.approach}</span>
              </label>
            ))}
          </div>
          {suggestion.status === "proposed" && (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={action.running("draft-review")} disabled={action.busy || selectedGoals.length === 0}
                onClick={() => void reviewSuggestion(suggestion, "review")}>
                Save selected planning notes
              </Button>
              <Button variant="secondary" disabled={action.busy}
                onClick={() => void reviewSuggestion(suggestion, "discard")}>Discard suggestion</Button>
            </div>
          )}
          <Text size="sm" variant="secondary">
            Selecting suggestions records a private review. It does not change a course page, rubric, assignment or student submission. Future lesson editing requires a separate approval-gated action.
          </Text>
          <div><Button variant="secondary" onClick={() => {
            setSuggestion(undefined); setDrafts(undefined);
          }}>Back to course library</Button></div>
        </section>
      )}
      {action.state.status === "failed" && <Problem error={action.state.error} />}
    </LayerCard>
  );
};
