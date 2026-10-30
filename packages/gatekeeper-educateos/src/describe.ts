// What the Workshop shows a person for each school read and change. Built with the kit's builder,
// so the tool's arguments are shown exactly as the district received them.
import { buildDescription, type ActionDescriptionBuilder } from "@gadgets/gatekeeper-kit/action-description";
import type { ActionPresentation } from "@gadgets/gatekeeper-kit/actions";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { SchoolChange, SchoolRead } from "./session.ts";

/**
 * The activity-log entry for a read the agent is about to receive. Every school read is student
 * or staff records, so it marks the workspace as holding restricted data: from then on the
 * Workshop refuses public web fetches and git pushes, and holds every action for a person, so a
 * prompt injection cannot carry the records out.
 */
export function describeRead(read: SchoolRead): ObservationDescription {
  const { description, fields } = withCall(buildDescription(
    "Reads school records with your access, through the district's school tools.",
  ), read).finish();
  return { title: `Read school records (${read.tool})`, description, fields, containsRestrictedData: true };
}

/** What a person reviews before deciding a queued change. */
export function describeChange(change: SchoolChange): ActionPresentation {
  const intro = change.needs === "approval"
    ? "Changes school records through the district's school tools. The district requires a teacher "
      + "of the class to approve this change. Approving it here approves it as you: if you may not, "
      + "it waits in EducateOS for someone who may."
    : "Changes school records through the district's school tools, with your access.";
  return { title: `Change school records (${change.tool})`, ...withCall(buildDescription(intro), change).finish(), implementsRevert: false };
}

function withCall(builder: ActionDescriptionBuilder, call: SchoolRead): ActionDescriptionBuilder {
  return builder
    .inline("Tool", call.tool)
    .json("Arguments", call.args)
    .inline("Reference", call.correlationId);
}
