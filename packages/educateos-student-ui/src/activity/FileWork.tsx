import { useId, useState } from "react";
import { Banner, Button, Text } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, ClockCounterClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { messageFor, useApi } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { formatDateTime } from "../labels.ts";
import type { ActivityStep, ArtifactRead, ArtifactView } from "../model.ts";
import { ArtifactViewer } from "../viewers/ArtifactViewer.tsx";
import { AudioRecorder } from "./AudioRecorder.tsx";
import { DrawingPad } from "./DrawingPad.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { UploadField } from "./UploadField.tsx";
import { formatList, type PickedFile } from "./uploadFormats.ts";
import type { CapturedWorkMode } from "./workMode.ts";

/**
 * A step whose work is a file, a drawing or a recording. Choosing a file, or finishing a drawing or
 * recording, saves it at once as the work's next version, so there is never unsaved work that a
 * submission would leave out; if the save fails, the work is kept on screen to try again.
 */
export const FileWork = ({ step, mode, title, saved, readOnly, large = false, ensureWorkspace, onSaved }: {
  step: ActivityStep;
  mode: CapturedWorkMode;
  title: string;
  /** The work's latest saved version, when there is one. */
  saved: ArtifactRead | undefined;
  readOnly: boolean;
  /** The young-learner size. */
  large?: boolean;
  ensureWorkspace: () => Promise<string>;
  onSaved: (view: ArtifactView) => void;
}) => {
  const api = useApi();
  const announce = useAnnounce();
  const fieldId = useId();
  const [current, setCurrent] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<{ file: PickedFile; message: string } | undefined>(undefined);
  const [showHistory, setShowHistory] = useState(false);

  const save = async (file: PickedFile) => {
    setSaving(true);
    setFailed(undefined);
    const content = file.kind === "text"
      ? { kind: "text" as const, mediaType: file.mediaType, text: file.text }
      : { kind: "bytes" as const, mediaType: file.mediaType, base64: file.base64 };
    try {
      const view = current === undefined
        ? await api.call("student.createArtifact", { body: { workspaceId: await ensureWorkspace(), type: mode.artifactType, title, content } })
        : await api.call("student.saveRevision", { params: { artifactId: current.artifact.id }, body: { content } });
      setCurrent({ artifact: view.artifact, revision: view.head, content: file.kind === "text" ? { kind: "text", text: file.text } : { kind: "bytes", base64: file.base64 } });
      onSaved(view);
      announce(mode.input === "file" ? `${file.name} saved for ${step.title}.` : `${file.name} is saved.`);
    } catch (error) {
      setFailed({ file, message: messageFor(error) });
      announce(`${file.name} was not saved.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {current === undefined ? <Text variant="secondary">Nothing uploaded yet.</Text> : <ArtifactViewer read={current} />}
      {readOnly ? null : mode.input === "file" ? (
        <div className="flex flex-col gap-1">
          <UploadField id={fieldId} formats={mode.formats} disabled={saving} onPicked={(file) => void save(file)} />
          {current === undefined ? null : <Text variant="secondary" size="sm">Choosing another file saves it as a new version. Earlier versions stay in History.</Text>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {current === undefined ? null : (
            <Text variant="secondary" size="sm">
              {mode.input === "picture" ? "Saving a new drawing or photo keeps this one in History." : "Saving a new recording keeps this one in History."}
            </Text>
          )}
          {/* Keyed by the saved version, so a saved drawing or recording leaves a fresh pad behind. */}
          {mode.input === "picture" ? (
            <>
              <DrawingPad key={current?.revision.id ?? "new"} stepTitle={step.title} disabled={saving} onDrawn={(file) => void save(file)} />
              <UploadField id={fieldId} label={`Or add a photo (${formatList(mode.formats)})`} formats={mode.formats} disabled={saving} onPicked={(file) => void save(file)} />
            </>
          ) : (
            <AudioRecorder key={current?.revision.id ?? "new"} stepTitle={step.title} formats={mode.formats} disabled={saving} large={large} onRecorded={(file) => void save(file)} />
          )}
        </div>
      )}

      {failed === undefined ? null : (
        <div role="alert" className="flex flex-col gap-2">
          <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title={`${failed.file.name} was not saved`} description={failed.message} />
          <div>
            <Button variant="secondary" icon={<ArrowClockwiseIcon aria-hidden />} loading={saving} onClick={() => void save(failed.file)}>
              Try again
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          icon={<ClockCounterClockwiseIcon aria-hidden />}
          disabled={current === undefined}
          aria-expanded={showHistory}
          onClick={() => setShowHistory(!showHistory)}
        >
          History
        </Button>
        <Text variant="secondary" size="sm">
          {readOnly ? "Read-only" : saving ? "Saving…" : current === undefined ? "Not started" : `Saved ${formatDateTime(current.revision.createdAt)}`}
        </Text>
      </div>
      {showHistory && current !== undefined ? <HistoryPanel artifactId={current.artifact.id} headId={current.revision.id} /> : null}
    </div>
  );
};
