import { useState } from "react";
import { Banner, Button, Checkbox, Empty, Input, InputArea, LayerCard, Radio, Text } from "@cloudflare/kumo";
import { CheckCircle, Eye, PencilSimple } from "@phosphor-icons/react";
import { useAnnounce } from "../Announcer.tsx";
import { classLabel } from "../classes/classLabel.ts";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Loading } from "../Loading.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import { routeHref } from "../route.ts";
import type { ActivityDefinition, Assignment, TeachingOffering } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { AI_HELP, buildActivity, emptyActivityForm, releaseKey, TEMPLATES, type ActivityContext, type ActivityForm } from "./activityForm.ts";
import { ClassNotes } from "./ClassNotes.tsx";
import { LearningGoalPicker } from "./LearningGoalPicker.tsx";
import { PublishPanel } from "./PublishPanel.tsx";
import { RubricChooser, type RubricChoice } from "./RubricChooser.tsx";
import { StudentPreview } from "./StudentPreview.tsx";
import { TemplateFields } from "./TemplateFields.tsx";
import { formatDateTime } from "../dates.ts";

const toggle = (list: readonly string[], key: string, on: boolean) => (on ? [...list, key] : list.filter((k) => k !== key));

type Phase =
  | { step: "compose" }
  | { step: "preview"; definition: ActivityDefinition }
  | { step: "published"; assignment: Assignment };

/**
 * Creates an activity from a template: compose it, preview it as a student, then publish and
 * assign it. Learning goals are optional, and come from the standards releases the district
 * approved, as they fit the course's subject and grades.
 */
export const CreateActivityPage = ({ teaching }: { teaching: TeachingOffering }) => {
  const offeringId = teaching.offering.id;
  const setup = useLoad(`create:${offeringId}`, async (client) => {
    const [releases, assignments, goals] = await Promise.all([
      client.call("teacher.listReleases", { params: { offeringId } }),
      client.call("teacher.listAssignments", { params: { offeringId } }),
      client.call("teacher.learningGoals", { params: { offeringId } }),
    ]);
    const earlier: RubricChoice[] = assignments.flatMap((a) => (a.rubric === undefined ? [] : [{ ref: a.rubric, label: `The rubric from “${a.title}”` }]));
    return { releases, goals, earlier };
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>{`Create activity · ${classLabel(teaching)}`}</PageHeading>
      {setup.status === "loading" && <Loading label="Getting your class ready…" />}
      {setup.status === "error" && <Problem error={setup.error} onRetry={setup.reload} />}
      {setup.status === "ready" && (
        <Composer
          teaching={teaching}
          context={{ subject: teaching.course.subject, gradeBand: teaching.course.gradeBand, goals: setup.data.goals.goals, releases: setup.data.releases }}
          approvedReleases={setup.data.goals.approvedReleases}
          earlier={setup.data.earlier}
        />
      )}
    </div>
  );
};

const Composer = ({ teaching, context, approvedReleases, earlier }: {
  teaching: TeachingOffering;
  context: ActivityContext;
  approvedReleases: number;
  earlier: readonly RubricChoice[];
}) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const offeringId = teaching.offering.id;
  const [form, setForm] = useState<ActivityForm>(emptyActivityForm);
  const [phase, setPhase] = useState<Phase>({ step: "compose" });
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState<{ status: "idle" | "saving" } | { status: "failed"; error: unknown }>({ status: "idle" });

  const preview = async () => {
    const built = buildActivity(form, context);
    if (!built.ok) {
      setProblems(built.problems);
      return;
    }
    setProblems([]);
    setSaving({ status: "saving" });
    try {
      const definition = await client.call("teacher.createActivity", { params: { offeringId }, body: { activity: built.input } });
      setSaving({ status: "idle" });
      setPhase({ step: "preview", definition });
      announce("Showing the activity as a student will see it.");
    } catch (error) {
      setSaving({ status: "failed", error });
    }
  };

  if (phase.step === "published") {
    return (
      <Empty
        icon={<CheckCircle size={32} aria-hidden />}
        title={`“${phase.assignment.title}” is assigned`}
        description={`Due ${formatDateTime(phase.assignment.dueAt)}. Students' work will appear under Submissions.`}
        contents={(
          <span className="flex flex-wrap justify-center gap-3">
            <a href={routeHref({ screen: "submissions", offeringId, assignmentId: phase.assignment.id })}>Go to submissions</a>
            <Button onClick={() => {
              setForm(emptyActivityForm());
              setPhase({ step: "compose" });
            }}>Create another activity</Button>
          </span>
        )}
      />
    );
  }

  if (phase.step === "preview") {
    return (
      <div className="flex flex-col gap-6">
        <StudentPreview definition={phase.definition} releases={context.releases} />
        <LayerCard className="flex flex-col gap-3 p-4">
          <h2><Text variant="heading" as="span">Publish and assign</Text></h2>
          <PublishPanel definition={phase.definition} offeringId={offeringId} rubric={form.rubric} onPublished={(assignment) => setPhase({ step: "published", assignment })} />
        </LayerCard>
        <div>
          <Button icon={<PencilSimple aria-hidden />} onClick={() => setPhase({ step: "compose" })}>Back to editing</Button>
        </div>
      </div>
    );
  }

  return (
    <form
      aria-label="New activity"
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void preview();
      }}
    >
      <Radio.Group legend="Template" appearance="card" value={form.template} onValueChange={(template) => setForm({ ...form, template: template as ActivityForm["template"] })}>
        {TEMPLATES.map((template) => <Radio.Item key={template.kind} value={template.kind} label={template.label} description={template.description} />)}
      </Radio.Group>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2"><Text variant="heading" as="span">About the activity</Text></legend>
        <Input label="Title" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
        <InputArea label="Overview for students" value={form.overview} onValueChange={(overview) => setForm({ ...form, overview })} />
        <TemplateFields form={form} onChange={setForm} />
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2"><Text variant="heading" as="span">Learning goals</Text></legend>
        <LearningGoalPicker goals={context.goals} approvedReleases={approvedReleases} chosen={form.goals} onChange={(goals) => setForm({ ...form, goals })} />
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2"><Text variant="heading" as="span">Resources</Text></legend>
        {context.releases.length === 0
          ? <Text variant="secondary">No approved resources yet. <a href={routeHref({ screen: "resources", offeringId })}>Add one under Resources</a>.</Text>
          : context.releases.map((release) => (
            <Checkbox
              key={releaseKey(release)}
              label={release.descriptor.title}
              checked={form.resources.includes(releaseKey(release))}
              onCheckedChange={(on) => setForm({ ...form, resources: toggle(form.resources, releaseKey(release), on === true) })}
            />
          ))}
      </fieldset>

      <ClassNotes notes={form.notes} onChange={(notes) => setForm({ ...form, notes })} />

      <Radio.Group
        legend="AI help"
        appearance="card"
        description="Your district may allow less. If it does, you'll be told when you preview."
        value={form.aiHelp}
        onValueChange={(aiHelp) => setForm({ ...form, aiHelp: aiHelp as ActivityForm["aiHelp"] })}
      >
        {AI_HELP.map((help) => <Radio.Item key={help.level} value={help.level} label={help.label} description={help.explanation} />)}
      </Radio.Group>

      <RubricChooser offeringId={offeringId} earlier={earlier} value={form.rubric} onChange={(rubric) => setForm({ ...form, rubric })} />

      {problems.length > 0 && (
        <div role="alert">
          <Banner variant="alert" title="A few things to finish" description={<ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>} />
        </div>
      )}
      {saving.status === "failed" && <Problem error={saving.error} />}
      <div>
        <Button type="submit" variant="primary" icon={<Eye aria-hidden />} loading={saving.status === "saving"}>Preview as student</Button>
      </div>
    </form>
  );
};
