import type { ResourceReport, RightsMode } from "../types.ts";

/**
 * The rights modes from narrowest to widest, in plain words. Each permits everything narrower. A
 * teacher may narrow a resource's mode; only a curriculum admin may widen it, because widening
 * claims rights the district must have checked.
 */
export const RIGHTS_MODES: readonly { mode: RightsMode; label: string; explanation: string }[] = [
  { mode: "link", label: "Link only", explanation: "Students follow a link to the original page. Nothing is copied." },
  { mode: "embed", label: "Embed", explanation: "Students see the original inside their class page, unchanged." },
  { mode: "excerpt", label: "Excerpt", explanation: "You may quote the part the license permits in an activity." },
  { mode: "licensed-copy", label: "Licensed copy", explanation: "The district keeps its own copy under the license, which classes can use in full." },
];

/** The plain-words description of `mode`. */
export const rightsMode = (mode: RightsMode) => RIGHTS_MODES.find((m) => m.mode === mode)!;

/** Whether choosing `to` instead of `from` widens what the class may do with a resource. */
export const widens = (from: RightsMode, to: RightsMode): boolean =>
  RIGHTS_MODES.findIndex((m) => m.mode === to) > RIGHTS_MODES.findIndex((m) => m.mode === from);

/** What a resource's license evidence shows, in plain words. */
export const licenseSummary = (license: ResourceReport["license"]): string => {
  switch (license.status) {
    case "recognized":
      return `Licensed ${license.license.name}.`;
    case "conflicting":
      return `The source names ${license.licenses.length} different licenses (${license.licenses.map((l) => l.name).join(", ")}), so none can be relied on.`;
    case "unrecognized":
      return "The source mentions a license, but not one we recognize.";
    case "absent":
      return "The source doesn't say how it's licensed.";
  }
};
