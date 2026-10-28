// "✦ Ask AI about this" (SCHO-260, plan §4): opens the district's AI workspace at /ai with what the
// screen is about. Offered only where the school's manifest says the district has AI. The workspace
// checks the context again for the signed-in teacher; the link only says where to start.
import { askAiHref, type AiContext } from "@educateos/shell";
import { useDistrictShell } from "./shell.tsx";

export const AskAi = ({ context }: { context: AiContext }) =>
  useDistrictShell()?.school.features.ai === true ? (
    <p>
      <a
        href={askAiHref(context)}
        className="inline-flex items-center gap-1 rounded-lg border border-kumo-line px-3 py-1.5 text-kumo-default no-underline hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-brand"
      >
        <span aria-hidden>✦</span>
        Ask AI about this
      </a>
    </p>
  ) : null;
