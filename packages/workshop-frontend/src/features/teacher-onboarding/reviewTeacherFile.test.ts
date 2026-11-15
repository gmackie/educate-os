import { afterEach, expect, it, vi } from "vitest";
import { reviewTeacherFile } from "./reviewTeacherFile";

const workers: FakeWorker[] = [];
class FakeWorker extends EventTarget {
  terminate = vi.fn<() => void>();
  postMessage = vi.fn<(value: unknown, transfer: Transferable[]) => void>();
  constructor() { super(); workers.push(this); }
}
const file = { blob: new Blob(["lesson"]), mimeType: "application/octet-stream", name: "lesson.docx" };
const result = { status: "unsupported" as const };

afterEach(() => { workers.length = 0; vi.unstubAllGlobals(); vi.useRealTimers(); });

it("releases the worker after a result and removes the abort listener", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const controller = new AbortController();
  const task = reviewTeacherFile(file, controller.signal);
  const removed = vi.spyOn(workers[0], "removeEventListener");
  expect(workers[0].postMessage).toHaveBeenCalledWith(file, []);
  workers[0].dispatchEvent(new MessageEvent("message", { data: result }));
  expect(await task).toEqual(result);
  controller.abort();
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(removed).toHaveBeenCalledTimes(3);
});

it("cancels a removed file's worker before accepting another response", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const controller = new AbortController();
  const task = reviewTeacherFile(file, controller.signal);
  controller.abort();
  await expect(task).rejects.toMatchObject({ name: "AbortError" });
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  workers[0].dispatchEvent(new MessageEvent("message", { data: result }));
  expect(workers[0].terminate).toHaveBeenCalledOnce();
});

it("bounds a stalled worker and surfaces failures without exposing file contents", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  const task = reviewTeacherFile(file, new AbortController().signal);
  const outcome = task.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await outcome).toEqual(new Error("Local file review is unavailable"));
  expect(workers[0].terminate).toHaveBeenCalledOnce();
});

it("handles workers blocked by browser policy", async () => {
  vi.stubGlobal("Worker", class { constructor() { throw new Error("blocked"); } });
  await expect(reviewTeacherFile(file, new AbortController().signal)).rejects.toThrow("blocked");
});
