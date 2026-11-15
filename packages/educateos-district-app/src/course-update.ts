// Read-only, teacher-facing comparison of an installed OCS course with a newer signed
// library version. This does not merge, import, publish or mutate classroom content.
// See docs/educateos/rfc/0004-cross-institution-course-collaboration.md (draft).
import type { CourseInstallPlan, PlannedItem, PlannedUnit } from "@educateos/ocs";
import type { OfferingId } from "@educateos/contracts";
import type { CourseOutline } from "@educateos/curriculum";
import type { InstalledCourse, InstalledUnit } from "./course-library.ts";

export type UpdateReviewStatus =
  | "unchanged" | "upstream-added" | "upstream-removed" | "upstream-changed"
  | "local-change" | "conflict" | "reconcile";

export interface CourseUpdateItemReview {
  key: string;
  title: string;
  kind: "activity" | "page" | "teacher-note" | "resource";
  status: UpdateReviewStatus;
  /** An assessment or instructor-only note requires particular care. No bodies are returned. */
  sensitive: boolean;
  explanation: string;
}

export interface CourseUpdateUnitReview {
  key: string;
  title: string;
  status: UpdateReviewStatus;
  items: CourseUpdateItemReview[];
  explanation: string;
}

export interface CourseUpdatePreview {
  offeringId: OfferingId;
  packageId: string;
  fromVersion: string;
  toVersion: string;
  fromDigest: string;
  toDigest: string;
  units: CourseUpdateUnitReview[];
  /** Explicit warning: this preview cannot update an offering. */
  requiresTeacherApproval: true;
  canApply: false;
  warnings: string[];
}

type LocalState = "same" | "changed" | "unknown";

function itemSnapshot(item: PlannedItem): string {
  // Ignore publication provenance; compare instructional content and referenced definitions.
  switch (item.kind) {
    case "page":
      return JSON.stringify([item.kind, item.title, item.body]);
    case "teacher-note":
      return JSON.stringify([item.kind, item.title, item.body, item.purpose]);
    case "activity":
      return JSON.stringify([item.kind, item.title, item.role, item.definition]);
    case "resource":
      return JSON.stringify([item.kind, item.title, item.resource, item.use]);
  }
}

function unitSnapshot(unit: PlannedUnit): string {
  return JSON.stringify([unit.title, unit.summary ?? "", unit.standards,
    unit.items.map((item) => item.key)]);
}

function localUnitState(
  unit: PlannedUnit,
  progress: InstalledUnit | undefined,
  installed: InstalledCourse,
  outline: CourseOutline,
): { state: LocalState; module: CourseOutline["modules"][number] | undefined; explanation: string } {
  if (progress === undefined || progress.status !== "installed" || progress.moduleId === undefined) {
    return { state: "unknown", module: undefined, explanation: "The original unit has no completed, attributable installation." };
  }
  const module = outline.modules.find((m) => m.id === progress.moduleId);
  if (module === undefined || module.source?.kind !== "course"
    || module.source.packageId !== installed.packageId
    || module.source.version !== installed.version
    || module.source.packageDigest !== installed.digest
    || module.source.unitKey !== unit.key) {
    return { state: "unknown", module: undefined, explanation: "The local module no longer matches its verified source identity." };
  }
  const seen = new Set<string>();
  for (const item of unit.items) {
    if (item.kind === "resource") continue; // Cross-district resource placement is not implemented.
    const record = progress.items[item.key];
    if (record?.moduleItemId === undefined) {
      return { state: "unknown", module, explanation: "The original item lacks a reliable local item mapping." };
    }
    const local = module.items.find((m) => m.id === record.moduleItemId);
    if (local === undefined || local.kind !== item.kind) {
      return { state: "unknown", module, explanation: "An original module item was removed or replaced." };
    }
    seen.add(local.id);
    if (item.kind === "activity") {
      if (local.kind !== "activity" || local.activityId !== record.activityId) {
        return { state: "unknown", module, explanation: "An activity's local placement cannot be matched." };
      }
      continue;
    }
    if (local.kind !== "page" && local.kind !== "teacher-note") {
      return { state: "unknown", module, explanation: "An original page is no longer a page." };
    }
    if (record.pageId === undefined || local.pageId !== record.pageId
      || !outline.pages.some((page) => page.id === record.pageId)) {
      return { state: "unknown", module, explanation: "An original page has no reliable local content mapping." };
    }
  }
  // Adding pages/activities is a valid teacher edit. It cannot be overwritten by upstream changes.
  if (module.title !== unit.title || module.items.some((item) => !seen.has(item.id))) {
    return { state: "changed", module, explanation: "The teacher changed the unit title or added local items." };
  }
  return { state: "same", module, explanation: "The source unit's local placements are accounted for." };
}

function localItemState(
  item: PlannedItem,
  progress: InstalledUnit | undefined,
  module: CourseOutline["modules"][number] | undefined,
  outline: CourseOutline,
): LocalState {
  if (item.kind === "resource") return "unknown"; // No portable destination release mapping in 1.1.
  if (progress?.status !== "installed" || module === undefined) return "unknown";
  const record = progress.items[item.key];
  if (record?.moduleItemId === undefined) return "unknown";
  const placement = module.items.find((m) => m.id === record.moduleItemId);
  if (placement === undefined || placement.kind !== item.kind) return "unknown";

  if (item.kind === "activity") {
    return placement.kind === "activity" && placement.activityId === record.activityId ? "same" : "unknown";
  }
  if (record.pageId === undefined || (placement.kind !== "page" && placement.kind !== "teacher-note")
      || placement.pageId !== record.pageId) return "unknown";
  const page = outline.pages.find((p) => p.id === record.pageId);
  if (page === undefined) return "unknown";
  if (placement.kind === "teacher-note"
    && (item.kind !== "teacher-note" || placement.purpose !== item.purpose)) return "changed";
  return page.title !== item.title || page.body !== item.body ? "changed" : "same";
}

const reportStatus = (upstreamChanged: boolean, local: LocalState): UpdateReviewStatus =>
  local === "unknown" ? "reconcile"
    : upstreamChanged && local === "changed" ? "conflict"
    : upstreamChanged ? "upstream-changed"
    : local === "changed" ? "local-change"
    : "unchanged";

function statusExplanation(status: UpdateReviewStatus): string {
  switch (status) {
    case "unchanged": return "No source change detected; local assignment settings are not compared.";
    case "upstream-added": return "New material in the publisher's version. Nothing is installed.";
    case "upstream-removed": return "Removed from the publisher's version; existing classroom content stays.";
    case "upstream-changed": return "Publisher changed this material; teacher review is required.";
    case "local-change": return "Local adaptation retained; the publisher did not change this material.";
    case "conflict": return "Both the teacher and publisher changed this material; compare before adopting.";
    case "reconcile": return "Cannot safely match this material to the original local installation.";
  }
}

/**
 * Compare two already resolved and verified OCS install plans with the current
 * staff-only outline. No cross-institution lookup, write, AI judgment, or automatic merge.
 *
 * This uses OCS stable unit/item paths, never titles for identity. Local page text is
 * compared in-process but never exposed in the preview response. A missing or skipped
 * source-to-local mapping is unknown rather than being guessed.
 *
 * Activity assignment settings, rubrics and grading are NOT compared here; they require
 * separate checks before any eventual apply operation. OCS resource references have no
 * portable local-release mapping yet and are always marked for reconciliation.
 */
export function previewCourseVersionUpdate(args: {
  offeringId: OfferingId;
  from: CourseInstallPlan;
  to: CourseInstallPlan;
  installed: InstalledCourse;
  outline: CourseOutline;
  fromDigest: string;
  toDigest: string;
}): CourseUpdatePreview {
  const { offeringId, from, to, installed, outline, fromDigest, toDigest } = args;
  const baseUnits = new Map(from.units.map((unit) => [unit.key, unit]));
  const nextUnits = new Map(to.units.map((unit) => [unit.key, unit]));
  const allKeys = [...new Set([...baseUnits.keys(), ...nextUnits.keys()])];
  const units = allKeys.map((key): CourseUpdateUnitReview => {
    const base = baseUnits.get(key);
    const next = nextUnits.get(key);
    if (base === undefined) {
      const added = next!;
      return {
        key, title: added.title, status: "upstream-added",
        explanation: statusExplanation("upstream-added"),
        items: added.items.map((item) => ({ key: item.key, title: item.title, kind: item.kind,
          sensitive: item.kind === "teacher-note" || (item.kind === "activity" && item.role === "assessment"),
          status: "upstream-added" as const, explanation: statusExplanation("upstream-added") })),
      };
    }
    const progress = installed.units.find((u) => u.unitKey === key);
    const { state: localState, module, explanation } = localUnitState(base, progress, installed, outline);
    const oldItems = new Map(base.items.map((item) => [item.key, item]));
    const newItems = new Map((next?.items ?? []).map((item) => [item.key, item]));
    const itemKeys = [...new Set([...oldItems.keys(), ...newItems.keys()])];
    const items = itemKeys.map((itemKey): CourseUpdateItemReview => {
      const previous = oldItems.get(itemKey);
      const candidate = newItems.get(itemKey);
      const item = candidate ?? previous!;
      const sensitive = item.kind === "teacher-note"
        || (item.kind === "activity" && item.role === "assessment")
        || (previous?.kind === "teacher-note")
        || (previous?.kind === "activity" && previous.role === "assessment");
      const local = previous === undefined ? "same" : localItemState(previous, progress, module, outline);
      const status = previous === undefined ? "upstream-added"
        : candidate === undefined ? (local === "unknown" ? "reconcile" : local === "changed" ? "conflict" : "upstream-removed")
        : reportStatus(itemSnapshot(previous) !== itemSnapshot(candidate), local);
      return { key: itemKey, title: item.title, kind: item.kind, sensitive,
        status, explanation: statusExplanation(status) };
    });
    const upstreamChanged = next === undefined || unitSnapshot(base) !== unitSnapshot(next)
      || items.some((item) => item.status === "upstream-added" || item.status === "upstream-removed"
        || item.status === "upstream-changed" || item.status === "conflict");
    let status: UpdateReviewStatus = reportStatus(upstreamChanged, localState);
    if (next === undefined) status = localState === "unknown" ? "reconcile"
      : localState === "changed" ? "conflict" : "upstream-removed";
    if (items.some((item) => item.status === "reconcile")) status = "reconcile";
    else if (items.some((item) => item.status === "conflict")) status = "conflict";
    else if (items.some((item) => item.status === "local-change")) {
      status = upstreamChanged ? "conflict" : "local-change";
    }
    return { key, title: (next ?? base).title, status, items,
      explanation: localState === "unknown" ? explanation : statusExplanation(status) };
  });

  const originalOrder = from.units.map((unit) => unit.key);
  const updatedOrder = to.units.map((unit) => unit.key);
  const warnings = [
    "Preview only: no classroom content, assignments, submissions or grades have changed.",
    "An update requires explicit teacher approval, current district policy, standards and rights review.",
    "Assessment definitions, rubric releases, active assignments and grading history need a separate review.",
  ];
  if (JSON.stringify(originalOrder) !== JSON.stringify(updatedOrder)) {
    warnings.push("The publisher changed unit order; local sequencing must be reviewed.");
  }
  if (units.some((unit) => unit.status === "reconcile")) {
    warnings.push("Some older or modified lessons lack trustworthy item mappings; manual reconciliation is required.");
  }
  return {
    offeringId, packageId: installed.packageId, fromVersion: installed.version, toVersion: to.course.version,
    fromDigest, toDigest, units, requiresTeacherApproval: true, canApply: false, warnings,
  };
}
