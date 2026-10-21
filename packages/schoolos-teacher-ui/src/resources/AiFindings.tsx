import { Badge, Banner, Text } from "@cloudflare/kumo";
import { Sparkle } from "@phosphor-icons/react";
import type { ResourceReport } from "../types.ts";

const CATEGORY: Record<string, string> = {
  accuracy: "Accuracy",
  bias: "Bias",
  "age-appropriateness": "Age fit",
  accessibility: "Accessibility",
  safety: "Safety",
  other: "Other",
};

/** The AI label every AI finding carries, so it is never mistaken for a decision. */
export const AI_SUGGESTION_LABEL = "AI suggestion — check before approving";

/**
 * The optional AI review. Its findings help the teacher look; they decide nothing, so the whole
 * section is labelled as a suggestion and each excerpt says whether it was found in the page.
 */
export const AiFindings = ({ ai }: { ai: ResourceReport["ai"] }) => (
  <section aria-labelledby="ai-heading" className="flex flex-col gap-3">
    <h2 id="ai-heading" className="flex items-center gap-2">
      <Sparkle aria-hidden />
      <Text variant="heading" as="span">{AI_SUGGESTION_LABEL}</Text>
    </h2>
    {ai === undefined || ai.status === "not-configured" ? (
      <Text variant="secondary">Your district hasn't turned on AI review.</Text>
    ) : ai.status === "skipped" ? (
      <Text variant="secondary">There was no text for an AI review to read.</Text>
    ) : ai.status === "failed" || ai.status === "invalid-output" ? (
      <Text variant="secondary">The AI review didn't finish. Review the resource yourself.</Text>
    ) : (
      <>
        <Banner variant="secondary" description={ai.notice} />
        {ai.findings.length === 0 ? <Text variant="secondary">The AI review found nothing to point out.</Text> : (
          <ul className="flex flex-col gap-3">
            {ai.findings.map((finding, index) => (
              <li key={index} className="flex flex-col gap-1 rounded border border-kumo-line p-3">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant="purple">AI suggestion</Badge>
                  <Badge variant="neutral">{CATEGORY[finding.category] ?? finding.category}</Badge>
                  <Text variant="secondary" size="sm" as="span">{`${finding.uncertainty} uncertainty`}</Text>
                </span>
                <Text>{finding.summary}</Text>
                <blockquote className="border-l-2 border-kumo-line pl-3">
                  <Text variant="secondary" size="sm">{finding.excerpt}</Text>
                </blockquote>
                {!finding.excerptVerified && <Text variant="secondary" size="sm">This quote isn't in the page. The AI may have made it up.</Text>}
              </li>
            ))}
          </ul>
        )}
      </>
    )}
  </section>
);
