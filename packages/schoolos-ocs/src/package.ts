import { canonicalJson, contentDigest } from "@schoolos/catalog";
import type { z } from "zod";
import { OcsError, type PackageIssue } from "./errors.ts";
import {
  OcsActivity,
  OcsCodexNote,
  OcsLock,
  OcsManifest,
  OcsResource,
  OcsUnit,
  type Sha256Digest,
} from "./schema.ts";

/**
 * A package's files: path to UTF-8 JSON text. Every file is data. The layout is fixed (RFC 0001
 * §3): `ocs.json`, an optional `ocs.lock`, and one JSON file per entry under `units/`,
 * `activities/`, `resources/` and `codex/`. Any other path, including any script, is refused.
 */
export type OcsFiles = Readonly<Record<string, string>>;

/** The manifest's path. */
export const MANIFEST_PATH = "ocs.json";
/** The lockfile's path. */
export const LOCK_PATH = "ocs.lock";

const ENTRY_PATH = /^(units|activities|resources|codex)\/([a-z][a-z0-9-]{0,62})\.json$/;
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 256 * 1024;

/** A package read and checked: its manifest, entries by ID, and its digest. */
export interface OcsPackage {
  manifest: OcsManifest;
  units: ReadonlyMap<string, OcsUnit>;
  activities: ReadonlyMap<string, OcsActivity>;
  resources: ReadonlyMap<string, OcsResource>;
  codex: ReadonlyMap<string, OcsCodexNote>;
  /** The lockfile the package was published with, if any. Only the course's own lock is used. */
  lock: OcsLock | undefined;
  digest: Sha256Digest;
}

const ENTRY_SCHEMAS = { units: OcsUnit, activities: OcsActivity, resources: OcsResource, codex: OcsCodexNote } as const;
type EntryDirectory = keyof typeof ENTRY_SCHEMAS;

const ITEM_DIRECTORY: Record<OcsUnit["items"][number]["kind"], EntryDirectory> = { activity: "activities", resource: "resources", codex: "codex" };

function parseJson(path: string, text: string, issues: PackageIssue[]): unknown {
  try {
    return JSON.parse(text);
  } catch {
    issues.push({ path, message: "is not valid JSON" });
    return undefined;
  }
}

function checkLayout(files: OcsFiles): PackageIssue[] {
  const issues: PackageIssue[] = [];
  const paths = Object.keys(files);
  if (paths.length > MAX_FILES) issues.push({ path: "", message: `a package holds at most ${MAX_FILES} files` });
  for (const path of paths) {
    if (path !== MANIFEST_PATH && path !== LOCK_PATH && !ENTRY_PATH.test(path)) {
      issues.push({ path, message: "is not part of the course package layout; packages hold only JSON data files, never code" });
    } else if (new TextEncoder().encode(files[path]!).byteLength > MAX_FILE_BYTES) {
      issues.push({ path, message: `is larger than ${MAX_FILE_BYTES} bytes` });
    }
  }
  if (!(MANIFEST_PATH in files)) issues.push({ path: MANIFEST_PATH, message: "is missing" });
  return issues;
}

/**
 * The package digest: SHA-256 over the canonical JSON of the sorted list of `[path, canonical
 * JSON of the file]` pairs (RFC 0001 §5). Formatting and key order do not change it, and the
 * lockfile is left out, because it is derived from the rest.
 *
 * @throws OcsError `invalid-package` if a file is not JSON or the layout is wrong.
 */
export async function packageDigest(files: OcsFiles): Promise<Sha256Digest> {
  const issues = checkLayout(files);
  const entries = Object.keys(files)
    .filter((path) => path !== LOCK_PATH)
    .toSorted()
    .map((path) => [path, canonicalJson(parseJson(path, files[path]!, issues))] as const);
  if (issues.length > 0) throw new OcsError({ kind: "invalid-package", issues });
  return contentDigest(entries);
}

const zodIssues = (path: string, error: z.ZodError): PackageIssue[] =>
  error.issues.map((issue) => ({ path: issue.path.length === 0 ? path : `${path}: ${issue.path.join(".")}`, message: issue.message }));

/**
 * Reads a package's files, checks every file against its schema and every reference between them,
 * and computes the digest.
 *
 * @throws OcsError `invalid-package` listing every problem found.
 */
export async function readPackage(files: OcsFiles): Promise<OcsPackage> {
  const issues = checkLayout(files);
  const parse = <S extends z.ZodType>(schema: S, path: string): z.output<S> | undefined => {
    const json = parseJson(path, files[path]!, issues);
    if (json === undefined) return undefined;
    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;
    issues.push(...zodIssues(path, parsed.error));
    return undefined;
  };

  const manifest = MANIFEST_PATH in files ? parse(OcsManifest, MANIFEST_PATH) : undefined;
  const lock = LOCK_PATH in files ? parse(OcsLock, LOCK_PATH) : undefined;
  const entries = { units: new Map(), activities: new Map(), resources: new Map(), codex: new Map() } as {
    units: Map<string, OcsUnit>;
    activities: Map<string, OcsActivity>;
    resources: Map<string, OcsResource>;
    codex: Map<string, OcsCodexNote>;
  };
  for (const path of Object.keys(files).toSorted()) {
    const match = ENTRY_PATH.exec(path);
    if (match === null) continue;
    const directory = match[1] as EntryDirectory;
    const entry = parse(ENTRY_SCHEMAS[directory], path) as { id: string } | undefined;
    if (entry === undefined) continue;
    if (entry.id !== match[2]) issues.push({ path, message: `holds ${entry.id}, but its file name says ${match[2]}` });
    (entries[directory] as Map<string, unknown>).set(entry.id, entry);
  }

  if (manifest !== undefined) {
    if (manifest.outline.length === 0) issues.push({ path: MANIFEST_PATH, message: "outline: a course needs at least one unit or module" });
    const moduleNames = new Set(manifest.modules.map((module) => module.name));
    const outlined = new Set<string>();
    for (const [index, entry] of manifest.outline.entries()) {
      if (entry.kind === "unit") {
        outlined.add(`unit:${entry.unit}`);
        if (!entries.units.has(entry.unit)) issues.push({ path: `${MANIFEST_PATH}: outline.${index}`, message: `there is no unit ${entry.unit}` });
      } else {
        outlined.add(`module:${entry.module}`);
        if (!moduleNames.has(entry.module)) issues.push({ path: `${MANIFEST_PATH}: outline.${index}`, message: `there is no module named ${entry.module}` });
      }
    }
    for (const name of moduleNames) {
      if (!outlined.has(`module:${name}`)) issues.push({ path: `${MANIFEST_PATH}: modules`, message: `module ${name} is not placed in the outline` });
    }
    for (const [index, override] of manifest.overrides.entries()) {
      const first = override.target.modules[0]!;
      if (!moduleNames.has(first)) issues.push({ path: `${MANIFEST_PATH}: overrides.${index}`, message: `there is no module named ${first}` });
    }
  }
  for (const unit of entries.units.values()) {
    for (const [index, item] of unit.items.entries()) {
      if (!entries[ITEM_DIRECTORY[item.kind]].has(item.ref)) {
        issues.push({ path: `units/${unit.id}.json: items.${index}`, message: `there is no ${item.kind} ${item.ref}` });
      }
    }
  }
  if (issues.length > 0 || manifest === undefined) throw new OcsError({ kind: "invalid-package", ...(manifest === undefined ? {} : { packageId: manifest.id }), issues });
  return { manifest, ...entries, lock, digest: await packageDigest(files) };
}

/** JSON with sorted keys, indented, with a final newline: the form OCS writes every file in. */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;
}

/** The files of a package, in the canonical form, from its parsed parts. */
export function writePackage(pkg: Omit<OcsPackage, "digest" | "lock"> & { lock?: OcsLock | undefined }): Record<string, string> {
  const files: Record<string, string> = { [MANIFEST_PATH]: formatJson(pkg.manifest) };
  if (pkg.lock !== undefined) files[LOCK_PATH] = formatJson(pkg.lock);
  for (const directory of Object.keys(ENTRY_SCHEMAS) as EntryDirectory[]) {
    for (const [id, entry] of pkg[directory]) files[`${directory}/${id}.json`] = formatJson(entry);
  }
  return files;
}

/**
 * The key of a place in a composed course: module names joined by `/`, then `:` and the unit ID,
 * then `#` and the item ID. A unit of the course itself has no module part. For example
 * `bio:cells`, `bio/safety:rules#goggles`, `intro`.
 */
export function outlineKey(target: { modules: readonly string[]; unit: string; item?: string | undefined }): string {
  const unit = target.modules.length === 0 ? target.unit : `${target.modules.join("/")}:${target.unit}`;
  return target.item === undefined ? unit : `${unit}#${target.item}`;
}
