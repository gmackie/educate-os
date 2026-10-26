import { Banner } from "@cloudflare/kumo";
import { CheckCircle, Warning } from "@phosphor-icons/react";
import type { AuthoringOutcome } from "./useAuthoringAction.ts";

/**
 * What a section's last change did, shown at the end of the section whose form made it, so it is
 * in view where the administrator acted. Screen readers hear it from the announcer already.
 */
export const ActionOutcome = ({ outcome, title }: { outcome: AuthoringOutcome | undefined; title: string }) => {
  if (outcome === undefined) return null;
  return outcome.kind === "refused"
    ? <Banner variant="error" icon={<Warning weight="fill" />} title={title} description={outcome.message} />
    : <Banner icon={<CheckCircle weight="fill" />} title={outcome.message} />;
};
