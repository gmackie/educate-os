import type { QueueEntry, ResourceReport } from "../types.ts";

/** Where a resource is in review, in plain words, and whether it is waiting for a decision. */
export const reviewStatus = (state: ResourceReport["state"]): { label: string; awaitingDecision: boolean } => {
  switch (state) {
    case "reviewed":
      return { label: "Ready for your review", awaitingDecision: true };
    case "approved":
    case "released":
    case "published":
      return { label: "Approved", awaitingDecision: false };
    case "rejected":
      return { label: "Not approved", awaitingDecision: false };
    default:
      return { label: "Being checked", awaitingDecision: false };
  }
};

/** Where a resource came from, for its source line. */
export const sourceLabel = (source: QueueEntry["source"]): string => (source.kind === "url" ? source.submittedUrl : source.fileName);
