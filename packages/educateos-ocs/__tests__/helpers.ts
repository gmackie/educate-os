import { expect } from "vitest";
import {
  formatJson,
  InMemoryPackageLibrary,
  type OcsActivity,
  type OcsCodexNote,
  type OcsFiles,
  type OcsManifest,
  type OcsResource,
  type OcsUnit,
  type PackageSource,
} from "../src/index.ts";

/** The parts of a test package. Everything but the ID, version and outline has a default. */
export interface PackageSpec {
  manifest: Partial<OcsManifest> & Pick<OcsManifest, "id" | "version" | "outline">;
  units?: OcsUnit[];
  activities?: OcsActivity[];
  resources?: OcsResource[];
  codex?: OcsCodexNote[];
}

/** A package's files, as an author would write them. */
export function packageFiles(spec: PackageSpec): Record<string, string> {
  const manifest: OcsManifest = {
    specVersion: "1.0",
    title: `Course ${spec.manifest.id}`,
    language: "en",
    standards: [],
    modules: [],
    overrides: [],
    ...spec.manifest,
  };
  const files: Record<string, string> = { "ocs.json": formatJson(manifest) };
  for (const unit of spec.units ?? []) files[`units/${unit.id}.json`] = formatJson(unit);
  for (const activity of spec.activities ?? []) files[`activities/${activity.id}.json`] = formatJson(activity);
  for (const resource of spec.resources ?? []) files[`resources/${resource.id}.json`] = formatJson(resource);
  for (const note of spec.codex ?? []) files[`codex/${note.id}.json`] = formatJson(note);
  return files;
}

/** A unit with the given items. */
export const unit = (id: string, items: OcsUnit["items"], title = `Unit ${id}`): OcsUnit => ({ id, title, standards: [], items });

/** An activity pointing at a published definition version. */
export const activity = (id: string, definitionId: string, version = 1, role: OcsActivity["role"] = "assignment"): OcsActivity =>
  ({ id, title: `Activity ${id}`, role, definition: { definitionId, version } }) as OcsActivity;

/** A resource release reference with the given use. */
export const resource = (id: string, use: OcsResource["use"], resourceId = `rsc_${id}`): OcsResource =>
  ({ kind: "release", id, title: `Resource ${id}`, release: { resourceId, version: "1.0.0" }, use }) as OcsResource;

/** A library holding the given packages, published in the given order. */
export async function libraryOf(...packages: OcsFiles[]): Promise<InMemoryPackageLibrary> {
  const library = new InMemoryPackageLibrary();
  for (const files of packages) await library.publish(files);
  return library;
}

/** A source that serves another source's packages, with `tamper` applied to the files it returns. */
export function tamperingSource(inner: PackageSource, tamper: (id: string, version: string, files: Record<string, string>) => Record<string, string>): PackageSource {
  return {
    listVersions: (id) => inner.listVersions(id),
    async getPackage(id, version) {
      const found = await inner.getPackage(id, version);
      return found === undefined ? undefined : { ...found, files: tamper(id, version, { ...found.files }) };
    },
  };
}

/** Expects a promise to reject with an OcsError of the given problem kind. */
export async function rejectsWithProblem(promise: Promise<unknown>, kind: string, message?: RegExp): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "EducateOsError", problem: { kind }, ...(message === undefined ? {} : { message: expect.stringMatching(message) }) });
}

/** Package IDs used across the suites. */
export const IDS = {
  course: "northfield.example/biology-9",
  bio: "openbio.example/cells-core",
  safety: "labsafe.example/lab-safety",
  history: "archive.example/civil-war-sources",
} as const;
