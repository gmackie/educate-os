import { useId, useState } from "react";
import { Banner, Button, Input, InputArea, Text } from "@cloudflare/kumo";
import { ClockCounterClockwiseIcon, FloppyDiskIcon, InfoIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { messageFor, useApi, useQuery } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { clearDraft, readDraft, writeDraft } from "../drafts.ts";
import { ErrorState } from "../ErrorState.tsx";
import { formatDateTime } from "../labels.ts";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import type { ActivityStep, ArtifactView } from "../model.ts";
import { ArtifactViewer } from "../viewers/ArtifactViewer.tsx";
import { CsvTable } from "../viewers/CsvTable.tsx";
import { DatasetGrid } from "./DatasetGrid.tsx";
import { FileWork } from "./FileWork.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { UploadField } from "./UploadField.tsx";
import { editableValue, type WorkMode } from "./workMode.ts";

/** What a work item needs from its activity. */
export interface WorkItemProps {
  step: ActivityStep;
  mode: WorkMode;
  /** The title the work is saved under. */
  title: string;
  /** Where unsaved changes are kept until they save. */
  draftKey: string;
  /** The work as last saved, when there is some. */
  saved: ArtifactView | undefined;
  /** A finished class: the work is shown, not edited. */
  readOnly: boolean;
  /** The course workspace's ID, opening it on the student's first save. */
  ensureWorkspace: () => Promise<string>;
  onSaved: (view: ArtifactView) => void;
}

type EditorProps = Omit<WorkItemProps, "saved" | "mode"> & { mode: Exclude<WorkMode, { input: "file" }>; saved: ArtifactView | undefined; savedValue: string };

const WorkEditor = ({ step, mode, title, draftKey, saved, savedValue: initialSaved, readOnly, ensureWorkspace, onSaved }: EditorProps) => {
  const api = useApi();
  const announce = useAnnounce();
  const fieldId = useId();
  const [restored] = useState(() => (readOnly ? undefined : readDraft(draftKey)));
  const [artifact, setArtifact] = useState(saved);
  const [savedValue, setSavedValue] = useState(initialSaved);
  const [value, setValue] = useState(restored ?? initialSaved);
  const [wasRestored] = useState(restored !== undefined && restored !== initialSaved);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [draftUnstored, setDraftUnstored] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | undefined>(undefined);
  const [showHistory, setShowHistory] = useState(false);
  const dirty = value !== savedValue;

  const change = (next: string) => {
    setValue(next);
    if (next === savedValue) clearDraft(draftKey);
    else setDraftUnstored(!writeDraft(draftKey, next));
  };

  const save = async () => {
    setSaving(true);
    setSaveError(undefined);
    const content = mode.input === "link"
      ? { kind: "external" as const, url: value.trim() }
      : { kind: "text" as const, mediaType: mode.input === "unsupported" ? "text/plain" : mode.mediaType, text: value };
    try {
      const view = artifact === undefined
        ? await api.call("student.createArtifact", { body: { workspaceId: await ensureWorkspace(), type: mode.artifactType, title, content } })
        : await api.call("student.saveRevision", { params: { artifactId: artifact.artifact.id }, body: { content } });
      setArtifact(view);
      setSavedValue(value);
      setLastSavedAt(view.head.createdAt);
      clearDraft(draftKey);
      onSaved(view);
      announce(`${step.title} saved.`);
    } catch (error) {
      // The typed text stays on screen and in the draft; nothing is lost by a failed save.
      setSaveError(messageFor(error));
      announce(`${step.title} was not saved. Your changes are kept on this device.`);
    } finally {
      setSaving(false);
    }
  };

  const label = `Your work for ${step.title}`;
  return (
    <div className="flex flex-col gap-3">
      {wasRestored && dirty ? (
        <Banner variant="secondary" size="sm" icon={<InfoIcon weight="fill" />} title="We kept your unsaved changes" description="Save to keep them for good." />
      ) : null}

      {mode.input === "writing" ? (
        <InputArea id={fieldId} label={label} value={value} readOnly={readOnly} autoResize minRows={8} onValueChange={change} />
      ) : null}
      {mode.input === "dataset" ? (
        <DatasetGrid label={label} columns={mode.columns} value={value} readOnly={readOnly} onChange={change} />
      ) : null}
      {mode.input === "upload" ? (
        <div className="flex flex-col gap-2">
          {readOnly ? null : <UploadField id={fieldId} formats={mode.formats} disabled={saving} onPicked={(file) => file.kind === "text" && change(file.text)} />}
          {value === "" ? <Text variant="secondary">Nothing uploaded yet.</Text> : <CsvTable text={value} caption={label} />}
        </div>
      ) : null}
      {mode.input === "link" ? (
        <Input id={fieldId} type="url" label={`Link to ${step.title}`} description="A link to your work in your school's documents." value={value} readOnly={readOnly} onChange={(event) => change(event.target.value)} />
      ) : null}

      {saveError === undefined ? null : (
        <div role="alert">
          <Banner
            variant="error"
            size="sm"
            icon={<WarningCircleIcon weight="fill" />}
            title="Not saved yet"
            description={`${saveError} Your changes are kept on this device until they save.`}
          />
        </div>
      )}
      {draftUnstored ? (
        <Text variant="error" size="sm">This browser can't keep a backup of your changes. Save before you leave this page.</Text>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {readOnly ? null : (
          <Button variant="primary" icon={<FloppyDiskIcon aria-hidden />} loading={saving} disabled={!dirty || saving} onClick={() => void save()}>
            Save
          </Button>
        )}
        <Button
          variant="secondary"
          icon={<ClockCounterClockwiseIcon aria-hidden />}
          disabled={artifact === undefined}
          aria-expanded={showHistory}
          onClick={() => setShowHistory(!showHistory)}
        >
          History
        </Button>
        <Text variant="secondary" size="sm">
          {readOnly ? "Read-only" : dirty ? "Unsaved changes" : lastSavedAt !== undefined ? `Saved ${formatDateTime(lastSavedAt)}` : artifact === undefined ? "Not started" : "All changes saved"}
        </Text>
      </div>
      {showHistory && artifact !== undefined ? <HistoryPanel artifactId={artifact.artifact.id} headId={artifact.head.id} /> : null}
    </div>
  );
};

/**
 * One step's work: its editor, Save and History. The saved version is loaded once, when the step
 * opens; after that the editor keeps its own copy, so saving never reloads the editor or moves focus.
 */
export const WorkItem = (props: WorkItemProps) => {
  const { step, mode, saved } = props;
  const [initial] = useState(saved);
  const [read, reload] = useQuery(`work:${initial?.head.id ?? `new:${props.draftKey}`}`, async (api) =>
    initial === undefined ? undefined : api.call("student.getArtifact", { params: { artifactId: initial.artifact.id } }));

  const heading = (
    <Text variant="heading" as="h3">
      {step.title}
    </Text>
  );
  if (read.status === "loading") return <div className="flex flex-col gap-2">{heading}<LoadingSkeleton label={`Loading ${step.title}`} /></div>;
  if (read.status === "error") return <div className="flex flex-col gap-2">{heading}<ErrorState error={read.error} title="We couldn't open this work" onRetry={reload} /></div>;

  const savedValue = editableValue(read.data);
  return (
    <div className="flex flex-col gap-3">
      {heading}
      <Text variant="secondary">{step.prompt}</Text>
      {mode.input === "unsupported" ? (
        <Text>Hand this in the way your teacher asked. This kind of file can't be added here yet.</Text>
      ) : mode.input === "file" ? (
        <FileWork {...props} mode={mode} saved={read.data} />
      ) : savedValue === undefined ? (
        // A file saved some other way: shown as it is, since it isn't text this editor can change.
        <ArtifactViewer read={read.data!} />
      ) : (
        <WorkEditor {...props} mode={mode} saved={initial} savedValue={savedValue} />
      )}
    </div>
  );
};
