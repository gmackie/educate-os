import type { LessonSourceFile, LessonSourceReview } from "@educateos/doc-extract/lesson-source";

/** Run a bounded local file check off the UI thread; cancellation releases all file/worker state. */
export const reviewTeacherFile = (
  file: LessonSourceFile & { blob: Blob },
  signal: AbortSignal,
): Promise<LessonSourceReview> => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(new DOMException("File review cancelled", "AbortError"));
    return;
  }
  const worker = new Worker(new URL("./lessonSourceWorker.ts", import.meta.url), { type: "module" });
  const finish = (complete: () => void) => {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
    worker.removeEventListener("message", receive);
    worker.removeEventListener("error", workerError);
    worker.removeEventListener("messageerror", fail);
    worker.terminate();
    complete();
  };
  const cancel = () => finish(() => reject(new DOMException("File review cancelled", "AbortError")));
  const fail = () => finish(() => reject(new Error("Local file review is unavailable")));
  const timeout = setTimeout(fail, 15_000);
  signal.addEventListener("abort", cancel, { once: true });
  const receive = (event: MessageEvent<LessonSourceReview>) => finish(() => resolve(event.data));
  const workerError = (event: ErrorEvent) => {
    event.preventDefault();
    fail();
  };
  worker.addEventListener("message", receive);
  worker.addEventListener("error", workerError);
  worker.addEventListener("messageerror", fail);
  try {
    // Dedicated workers accept a transfer list, not a targetOrigin.
    worker.postMessage(file, []);
  } catch {
    fail();
  }
});
