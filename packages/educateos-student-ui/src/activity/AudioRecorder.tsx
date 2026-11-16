import { useId, useState } from "react";
import { Banner, Button, Text } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, FloppyDiskIcon, MicrophoneIcon, MicrophoneSlashIcon, StopIcon } from "@phosphor-icons/react";
import { MAX_UPLOAD_BYTES } from "@educateos/api-client";
import { useAnnounce } from "../AppContext.tsx";
import { UploadField } from "./UploadField.tsx";
import { formatList, megabytes, toBase64, type PickedFile, type UploadFormat } from "./uploadFormats.ts";
import { canRecord, MAX_RECORDING_SECONDS, useAudioRecorder } from "./useAudioRecorder.ts";

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * Records the student's voice, lets them listen back, and hands the recording over to save. Where
 * the browser can't record, or the microphone is refused, an upload takes its place; elsewhere it
 * is offered too, folded away. `large` is the young-learner size.
 */
export const AudioRecorder = ({ stepTitle, formats, disabled, large, onRecorded }: {
  stepTitle: string;
  formats: readonly UploadFormat[];
  disabled: boolean;
  large: boolean;
  onRecorded: (file: PickedFile) => void;
}) => {
  const announce = useAnnounce();
  const uploadId = useId();
  const { state, start, stop, reset } = useAudioRecorder();
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const supported = canRecord();
  const size = large ? "lg" : "base";
  const big = large ? "min-h-14 px-6 text-lg" : undefined;

  const save = async () => {
    if (state.status !== "recorded") return;
    if (state.blob.size > MAX_UPLOAD_BYTES) {
      setProblem(`That recording is too big to keep. Record a shorter one, under ${megabytes(MAX_UPLOAD_BYTES)}.`);
      return;
    }
    setProblem(undefined);
    const base64 = toBase64(new Uint8Array(await state.blob.arrayBuffer()));
    onRecorded({ kind: "bytes", name: "Your recording", mediaType: state.mediaType, base64 });
  };

  const upload = <UploadField id={uploadId} label={`Upload a recording (${formatList(formats)})`} formats={formats} disabled={disabled} onPicked={onRecorded} />;

  if (!supported) {
    return (
      <div className="flex flex-col gap-2">
        <Text variant="secondary">This browser can't record here. You can upload a recording instead.</Text>
        {upload}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {state.status === "denied" ? (
        <Banner
          variant="secondary"
          icon={<MicrophoneSlashIcon weight="fill" />}
          title="We can't use the microphone"
          description="Ask a grown-up to allow the microphone for this site, then try again. Or upload a recording below."
        />
      ) : null}
      {state.status === "failed" ? <Banner variant="error" icon={<MicrophoneSlashIcon weight="fill" />} title={state.message} /> : null}

      <div className="flex flex-wrap items-center gap-3">
        {state.status === "recording" ? (
          <>
            <Button variant="destructive" size={size} className={big} icon={<StopIcon aria-hidden weight="fill" />} onClick={() => (stop(), announce("Recording stopped."))}>
              Stop
            </Button>
            <Text>
              <span role="timer" aria-label="Recording time" className="font-semibold tabular-nums">{clock(state.seconds)}</span>
              <span className="text-kumo-subtle">{` of ${clock(MAX_RECORDING_SECONDS)}`}</span>
            </Text>
          </>
        ) : state.status === "recorded" ? null : (
          <Button
            variant="primary"
            size={size}
            className={big}
            icon={<MicrophoneIcon aria-hidden weight="fill" />}
            loading={state.status === "requesting"}
            disabled={disabled}
            aria-label={`Record your answer for ${stepTitle}`}
            onClick={() => void start().then((outcome) => {
              if (outcome === "recording") announce("Recording. Press Stop when you're done.");
            })}
          >
            {state.status === "denied" || state.status === "failed" ? "Try again" : "Record"}
          </Button>
        )}
      </div>

      {state.status === "recorded" ? (
        <div className="flex flex-col gap-3">
          <audio controls src={state.url} aria-label="Your new recording" className="w-full max-w-md" />
          <div className="flex flex-wrap gap-3">
            <Button variant="primary" size={size} className={big} icon={<FloppyDiskIcon aria-hidden />} disabled={disabled} onClick={() => void save()}>
              Save my recording
            </Button>
            <Button size={size} className={big} icon={<ArrowCounterClockwiseIcon aria-hidden />} disabled={disabled} onClick={() => (setProblem(undefined), reset())}>
              Record again
            </Button>
          </div>
        </div>
      ) : null}
      {problem === undefined ? null : <Text variant="error" size="sm"><span role="alert">{problem}</span></Text>}

      {state.status === "denied" || state.status === "failed" ? upload : (
        <details>
          <summary className="cursor-pointer text-sm text-kumo-subtle">Upload a recording instead</summary>
          <div className="pt-2">{upload}</div>
        </details>
      )}
    </div>
  );
};
