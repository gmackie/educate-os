import { useEffect, useRef, useState } from "react";
import type { UploadMediaType } from "@educateos/api-client";

/** The longest recording, which keeps every recording well under the district's upload limit. */
export const MAX_RECORDING_SECONDS = 120;

/** Where a recording stands. */
export type RecorderState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "recording"; seconds: number }
  | { status: "recorded"; blob: Blob; url: string; mediaType: UploadMediaType }
  /** The student or the browser refused the microphone. */
  | { status: "denied" }
  | { status: "failed"; message: string };

/** The recording formats the district takes, in the order browsers are asked for them. */
const RECORDING_TYPES: readonly { mimeType: string; mediaType: UploadMediaType }[] = [
  { mimeType: "audio/webm;codecs=opus", mediaType: "audio/webm" },
  { mimeType: "audio/webm", mediaType: "audio/webm" },
  { mimeType: "audio/mp4", mediaType: "audio/mp4" },
  { mimeType: "audio/ogg;codecs=opus", mediaType: "audio/ogg" },
];

/** Whether this browser can record from a microphone at all. Where it can't, only uploading is offered. */
export const canRecord = (): boolean =>
  typeof MediaRecorder !== "undefined" && typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";

/** The district media type a recorder's own type names, if the district takes it. */
const uploadTypeOf = (mimeType: string): UploadMediaType | undefined => {
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  return RECORDING_TYPES.find((type) => type.mediaType === base)?.mediaType;
};

/**
 * Records from the microphone with `MediaRecorder`. Asking for the microphone happens only when the
 * student presses record; a refusal is its own state, so the screen can explain it and offer an
 * upload instead. The microphone is released as soon as recording stops or the recorder leaves the
 * page, and a recording stops by itself at {@link MAX_RECORDING_SECONDS}.
 */
export const useAudioRecorder = () => {
  const [state, setState] = useState<RecorderState>({ status: "idle" });
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const stream = useRef<MediaStream | undefined>(undefined);
  const url = useRef<string | undefined>(undefined);

  const release = () => {
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = undefined;
  };
  const discard = () => {
    if (url.current !== undefined) URL.revokeObjectURL(url.current);
    url.current = undefined;
  };

  const unmounted = useRef(false);
  useEffect(() => () => {
    unmounted.current = true;
    if (recorder.current?.state === "recording") recorder.current.stop();
    release();
    discard();
  }, []);

  const recording = state.status === "recording";
  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      if (seconds >= MAX_RECORDING_SECONDS) recorder.current?.stop();
      else setState((previous) => (previous.status === "recording" ? { status: "recording", seconds } : previous));
    }, 250);
    return () => clearInterval(timer);
  }, [recording]);

  /** Asks for the microphone and starts recording, resolving to how that went. */
  const start = async (): Promise<"recording" | "denied" | "failed"> => {
    discard();
    setState({ status: "requesting" });
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setState({ status: "denied" });
        return "denied";
      }
      setState({ status: "failed", message: name === "NotFoundError" ? "We couldn't find a microphone." : "We couldn't start the microphone." });
      return "failed";
    }
    stream.current = media;
    const chosen = RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type.mimeType));
    let made: MediaRecorder;
    try {
      made = chosen === undefined ? new MediaRecorder(media) : new MediaRecorder(media, { mimeType: chosen.mimeType });
    } catch {
      release();
      setState({ status: "failed", message: "This browser can't record here." });
      return "failed";
    }
    const mediaType = chosen?.mediaType ?? uploadTypeOf(made.mimeType);
    if (mediaType === undefined) {
      release();
      setState({ status: "failed", message: "This browser records in a format the school can't keep." });
      return "failed";
    }
    const chunks: Blob[] = [];
    made.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    made.addEventListener("stop", () => {
      release();
      // A recording stopped because the recorder left the page is dropped.
      if (unmounted.current) return;
      const blob = new Blob(chunks, { type: mediaType });
      if (blob.size === 0) {
        setState({ status: "failed", message: "Nothing was recorded. Try again." });
        return;
      }
      url.current = URL.createObjectURL(blob);
      setState({ status: "recorded", blob, url: url.current, mediaType });
    });
    recorder.current = made;
    made.start();
    setState({ status: "recording", seconds: 0 });
    return "recording";
  };

  const stop = () => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  };

  const reset = () => {
    discard();
    setState({ status: "idle" });
  };

  return { state, start, stop, reset };
};
