// "✦ Ask AI about this" (SCHO-260, plan §4): opens the district's AI workspace at /ai with what the
// page is about. Offered only where the school's manifest says the district has AI. The workspace
// checks the context again for the signed-in person; the link only says where to start.
import { LinkButton } from "@cloudflare/kumo";
import { askAiHref, type AiContext } from "@educateos/shell";
import { useSchoolFeatures } from "./shell.tsx";

export const AskAi = ({ context }: { context: AiContext }) =>
  useSchoolFeatures().ai ? (
    <div>
      <LinkButton href={askAiHref(context)} variant="secondary">
        <span aria-hidden>✦ </span>Ask AI about this
      </LinkButton>
    </div>
  ) : null;
