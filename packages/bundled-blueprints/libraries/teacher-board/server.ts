/** Shared preparation storage and bounded input handling for the teacher blueprints. */
export type { BoardApi, BoardCard, BoardResult, Preparation } from "./src/protocol.ts";
import type { Preparation } from "./src/protocol.ts";

/** The subset of Durable Object storage used by preparation notes. */
export interface PreparationStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
/** Read local notes; source records are deliberately never stored here. */
export async function getPreparation(storage: PreparationStorage): Promise<Preparation> {
  return await storage.get<Preparation>("preparation") ?? { notes: "", tasks: [] };
}
/** Save bounded notes and tasks. RPC callers do not get to choose storage keys. */
export async function savePreparation(storage: PreparationStorage, value: Preparation): Promise<void> {
  if (!value || typeof value.notes !== "string" || value.notes.length > 12000 ||
      !Array.isArray(value.tasks) || value.tasks.length > 50 ||
      value.tasks.some(task => !task || typeof task.id !== "string" || task.id.length > 100 ||
        typeof task.text !== "string" || !task.text.trim() || task.text.length > 300 ||
        typeof task.done !== "boolean") || new Set(value.tasks.map(task => task.id)).size !== value.tasks.length) {
    throw new Error("Keep notes under 12,000 characters and use up to 50 preparation tasks of 300 characters each.");
  }
  await storage.put("preparation", { notes: value.notes, tasks: value.tasks.map(task => ({
    id: task.id, text: task.text, done: task.done,
  })) });
}
/** Only public web navigation schemes are usable in a source card. */
export function sourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch { return undefined; }
}

/** Markdown export contains teacher-authored preparation only, never a fresh provider read. */
export function preparationMarkdown(value: Preparation): string {
  return "# Teacher preparation\n\n" + value.notes + "\n\n## Checklist\n\n" +
    value.tasks.map(task => `- [${task.done ? "x" : " "}] ${task.text.replace(/[\r\n]/g, " ")}`).join("\n") + "\n";
}
