// The adapter for the Texas Education Agency's CASE 1.0 service, teks-api.texasgateway.org
// (SCHO-61). Its deviations, as observed on 2026-10-21 in chapters 110-113, 115 and the 2022
// Prekindergarten Guidelines:
//
// - `CFDocument.subject` is a string, not a list.
// - The `GET /CFDocuments` listing is a bare array, and its documents give `null` for absent
//   optional fields (`licenseURI`, `notes`, `publisher`, `officialSourceURL`, `description`,
//   `version`).
// - No item carries `educationLevel`. Grades and courses are items of type `Grade/Course` (such as
//   "Grade 3, Adopted 2012." or "Algebra I, Adopted 2012 (One Credit).") under `Subchapter` items
//   for elementary, middle and high school, and every expectation sits beneath its course.
//
// Every other field must already be CASE 1.1: the strict schemas validate the adapted JSON.
import type { AdaptationChange } from "../primitives.ts";
import type { Adapted, AdaptationTarget, CaseAdapter, CaseAdaptation } from "./adapter.ts";

const ID = "tea-teks-api@1";

/** CEDS education levels, kindergarten through grade 12. */
const K12 = ["KG", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"] as const;
const grade = (n: number) => K12[n];

/** CASE 1.1's optional `CFDocument` fields, which TEA's listing sends as `null` when absent. */
const OPTIONAL_DOCUMENT_FIELDS = [
  "CFPackageURI",
  "frameworkType",
  "caseVersion",
  "officialSourceURL",
  "publisher",
  "description",
  "subject",
  "subjectURI",
  "language",
  "version",
  "adoptionStatus",
  "statusStartDate",
  "statusEndDate",
  "licenseURI",
  "notes",
  "extensions",
] as const;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : undefined);

class Recorder {
  readonly adaptations: CaseAdaptation[] = [];

  add(target: AdaptationTarget, field: string, change: AdaptationChange, detail?: string): void {
    this.adaptations.push({ adapter: ID, field, change, target, ...(detail === undefined ? {} : { detail }) });
  }
}

/** Fixes a document's string `subject` and `null` optional fields in place. */
function adaptDocument(document: unknown, path: string, recorder: Recorder): void {
  if (!isObject(document)) return;
  const identifier = text(document["identifier"]);
  if (identifier === undefined) return;
  const target: AdaptationTarget = { kind: "document", identifier };
  for (const field of OPTIONAL_DOCUMENT_FIELDS) {
    if (document[field] === null) {
      delete document[field];
      recorder.add(target, `${path}.${field}`, "null-omitted");
    }
  }
  if (typeof document["subject"] === "string") {
    document["subject"] = [document["subject"]];
    recorder.add(target, `${path}.subject`, "string-to-list");
  }
}

/** The levels a grade or course statement names: pre-K, kindergarten, `Grade 3` or `Grades 7-8`. */
function levelsNamed(statement: string): string[] | undefined {
  if (/\bPrekindergarten\b|\bPK\d?\b/.test(statement)) return ["PK"];
  if (/\bKindergarten\b/.test(statement)) return ["KG"];
  const range = /\bGrades (\d{1,2})\s*[-–]\s*(\d{1,2})\b/.exec(statement);
  if (range !== null) {
    const [from, to] = [Number(range[1]), Number(range[2])];
    if (from > to || grade(to) === undefined) return undefined;
    return K12.slice(from, to + 1);
  }
  const single = /\bGrade (\d{1,2})\b/.exec(statement);
  const level = single === null ? undefined : grade(Number(single[1]));
  return level === undefined ? undefined : [level];
}

/** The levels a school division names: elementary is K-5, middle school 6-8, high school 9-12. */
function levelsOfDivision(statement: string): string[] | undefined {
  if (/\bHigh School\b/.test(statement)) return K12.slice(9);
  if (/\bMiddle School\b/.test(statement)) return K12.slice(6, 9);
  if (/\bElementary\b/.test(statement)) return K12.slice(0, 6);
  return undefined;
}

/**
 * Gives each item without an `educationLevel` the levels of the course or division it sits under,
 * walking up the package's `isChildOf` associations.
 *
 * A `Grade/Course` item takes the grade its statement names, or else the division of the nearest
 * ancestor that names one (TEA's high-school courses name no grade). A `Subchapter` takes its own
 * division. Every other item takes the levels of its nearest such ancestor, and an item with none
 * is left without levels rather than guessed at.
 */
function deriveEducationLevels(pkg: Json, recorder: Recorder): void {
  const items = Array.isArray(pkg["CFItems"]) ? pkg["CFItems"].filter(isObject) : [];
  const byId = new Map(items.flatMap((item) => (text(item["identifier"]) === undefined ? [] : [[text(item["identifier"])!, item]])));
  const parentOf = new Map<string, string>();
  for (const association of Array.isArray(pkg["CFAssociations"]) ? pkg["CFAssociations"].filter(isObject) : []) {
    const origin = isObject(association["originNodeURI"]) ? text(association["originNodeURI"]["identifier"]) : undefined;
    const destination = isObject(association["destinationNodeURI"]) ? text(association["destinationNodeURI"]["identifier"]) : undefined;
    // An item with two parents has no single course to inherit from, so it keeps neither.
    if (association["associationType"] !== "isChildOf" || origin === undefined || destination === undefined) continue;
    parentOf.set(origin, parentOf.has(origin) ? "" : destination);
  }

  const ancestors = function* (identifier: string) {
    const seen = new Set<string>([identifier]);
    for (let id = parentOf.get(identifier); id !== undefined && id !== "" && !seen.has(id); id = parentOf.get(id)) {
      seen.add(id);
      const item = byId.get(id);
      if (item === undefined) return;
      yield item;
    }
  };

  /** The levels a level-defining item gives itself and its descendants, and why. */
  const ownLevels = (item: Json): { levels: string[]; from: Json } | undefined => {
    const statement = text(item["fullStatement"]) ?? "";
    switch (item["CFItemType"]) {
      case "Grade/Course": {
        const named = levelsNamed(statement);
        if (named !== undefined) return { levels: named, from: item };
        for (const ancestor of ancestors(text(item["identifier"])!)) {
          const division = levelsOfDivision(text(ancestor["fullStatement"]) ?? "");
          if (division !== undefined) return { levels: division, from: item };
        }
        return undefined;
      }
      case "Subchapter": {
        const division = levelsOfDivision(statement);
        return division === undefined ? undefined : { levels: division, from: item };
      }
      default:
        return undefined;
    }
  };

  for (const item of items) {
    const identifier = text(item["identifier"]);
    if (identifier === undefined || item["educationLevel"] !== undefined) continue;
    let derived = ownLevels(item);
    for (const ancestor of derived === undefined ? ancestors(identifier) : []) {
      derived = ownLevels(ancestor);
      if (derived !== undefined) break;
    }
    if (derived === undefined) continue;
    item["educationLevel"] = derived.levels;
    const source = derived.from;
    const label = text(source["humanCodingScheme"]) ?? text(source["identifier"]);
    recorder.add({ kind: "item", identifier }, "educationLevel", "derived-education-level", `from ${String(source["CFItemType"])} ${label}`);
  }
}

/**
 * The adapter for TEA's `teks-api` CASE packages. Turns `CFDocument.subject` into a list, drops
 * `null` optional document fields, accepts the bare-array `CFDocuments` listing, and derives
 * education levels from course structure, reporting each change.
 */
export const TEA_TEKS_ADAPTER: CaseAdapter = {
  id: ID,

  adaptPackage(raw: unknown): Adapted<unknown> {
    const recorder = new Recorder();
    if (isObject(raw)) {
      adaptDocument(raw["CFDocument"], "CFDocument", recorder);
      deriveEducationLevels(raw, recorder);
    }
    return { value: raw, adaptations: recorder.adaptations };
  },

  adaptDocumentSet(raw: unknown): Adapted<unknown> {
    const recorder = new Recorder();
    let value = raw;
    if (Array.isArray(raw)) {
      value = { CFDocuments: raw };
      recorder.add({ kind: "listing" }, "CFDocuments", "listing-wrapped");
    }
    if (isObject(value) && Array.isArray(value["CFDocuments"])) {
      for (const document of value["CFDocuments"]) adaptDocument(document, "CFDocument", recorder);
    }
    return { value, adaptations: recorder.adaptations };
  },
};
