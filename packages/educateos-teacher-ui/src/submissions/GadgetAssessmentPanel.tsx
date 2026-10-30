import { useId, useState } from "react";
import { Button, Text } from "@cloudflare/kumo";
import { importWorkshopAssessmentBlueprint, type WorkshopAssessmentBlueprint } from "@educateos/assessment-sdk";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { FILE_INPUT_CLASS } from "../fileInputClass.ts";
import { Loading } from "../Loading.tsx";
import { Problem } from "../Problem.tsx";
import type { Assignment } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { formatDateTime } from "../dates.ts";

/** A teacher pins a reviewed Workshop release to this assignment; the district owns the binding. */
export const GadgetAssessmentPanel = ({ assignment }: { assignment: Assignment }) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const inputId = useId();
  const binding = useLoad(`gadget-assessment:${assignment.id}`, (api) => api.call("teacher.getGadgetAssessment", { params: { assignmentId: assignment.id } }));
  const [upload, setUpload] = useState<
    { status: "empty" | "reading" } | { status: "ready"; blueprint: WorkshopAssessmentBlueprint } | { status: "invalid" }
  >({ status: "empty" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();

  const read = async (file: File) => {
    setUpload({ status: "reading" });
    setError(undefined);
    try {
      if (file.size > 512 * 1024) throw new Error("Export exceeds 512 KB.");
      const blueprint = await importWorkshopAssessmentBlueprint(JSON.parse(await file.text()));
      setUpload({ status: "ready", blueprint });
    } catch {
      setUpload({ status: "invalid" });
    }
  };

  const bind = async () => {
    if (upload.status !== "ready" || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await client.call("teacher.bindGadgetAssessment", { params: { assignmentId: assignment.id }, body: { blueprint: upload.blueprint } });
      setUpload({ status: "empty" });
      binding.reload();
      announce("Gadget assessment release pinned to this assignment.");
    } catch (failure) {
      setError(failure);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby={`${inputId}-heading`} className="flex flex-col gap-3 rounded border border-kumo-line p-4">
      <h2 id={`${inputId}-heading`}><Text variant="heading" as="span">Gadget assessment</Text></h2>
      {binding.status === "loading" && <Loading label="Loading the Gadget assessment…" />}
      {binding.status === "error" && <Problem error={binding.error} onRetry={binding.reload} />}
      {binding.status === "ready" && binding.data !== null && (
        <>
          <Text bold>{binding.data.blueprint.definition.title}</Text>
          <Text variant="secondary">{`Pinned ${formatDateTime(binding.data.boundAt)}. This assignment keeps its release when the shared Blueprint changes.`}</Text>
          <dl className="grid gap-1 break-all text-sm">
            <dt>Blueprint</dt><dd>{binding.data.blueprint.blueprint.id}</dd>
            <dt>Release commit</dt><dd>{binding.data.blueprint.blueprint.commitId}</dd>
            <dt>Source fingerprint</dt><dd>{binding.data.blueprint.blueprint.sourceDigest}</dd>
            <dt>Pinned rubric</dt><dd>{`${binding.data.rubric.rubricId} · version ${binding.data.rubric.version}`}</dd>
          </dl>
          <Text variant="secondary" size="sm">Use a new assignment to adopt a different release. Student evidence and teacher reviews stay in this class.</Text>
        </>
      )}
      {binding.status === "ready" && binding.data === null && (
        <>
          <Text variant="secondary">No Gadget assessment is attached to this assignment.</Text>
          {assignment.rubric === undefined ? <Text>Add a signed rubric before attaching a Gadget assessment.</Text> : (
            <>
              <Text variant="secondary" size="sm">Choose a public assessment export obtained from your school's Workshop. Review its source before pinning it. The export's fingerprints identify content; they do not authenticate its publisher. Pin before any student submits work.</Text>
              <label htmlFor={inputId} className="text-sm font-medium">Workshop assessment export (.json)</label>
              <input id={inputId} type="file" accept=".json,application/json" className={FILE_INPUT_CLASS} disabled={saving || upload.status === "reading"} onChange={(event) => {
                const file = event.target.files?.[0];
                if (file === undefined) setUpload({ status: "empty" });
                else void read(file);
              }} />
              {upload.status === "reading" && <Loading label="Reading the assessment export…" />}
              {upload.status === "invalid" && <p role="alert" className="text-kumo-danger">Choose a valid Workshop assessment export of up to 512 KB. Its assessment fingerprint must match and it must contain no private records.</p>}
              {upload.status === "ready" && (
                <div className="flex flex-col gap-2">
                  <Text bold>{upload.blueprint.definition.title}</Text>
                  <Text variant="secondary" size="sm">{`Release ${upload.blueprint.blueprint.commitId}`}</Text>
                  <Text variant="secondary" size="sm">{`Will pin rubric ${assignment.rubric.rubricId}, version ${assignment.rubric.version}. This choice cannot be replaced on this assignment.`}</Text>
                  <div><Button variant="primary" loading={saving} onClick={() => void bind()}>Pin reviewed release to assignment</Button></div>
                </div>
              )}
            </>
          )}
        </>
      )}
      {error !== undefined && <Problem error={error} />}
    </section>
  );
};
