import { useState } from "react";
import { Badge, Breadcrumbs, Button, Surface, Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";
import { useAnnounce } from "../AppContext.tsx";
import { messageFor, useApi, useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { EVIDENCE_LABEL } from "./labels.ts";
import { progressPath } from "./paths.ts";

type Detail = RouteResponse<"family.session">;
type ItemEntry = Detail["items"][number];
type Answer = NonNullable<ItemEntry["response"]>["answers"][number];

const VERDICTS = [
  { verdict: "independent", label: "On their own" },
  { verdict: "with-help", label: "With help" },
  { verdict: "incorrect", label: "Not right" },
  { verdict: "exclude", label: "Don't count this" },
] as const;

/** What an item asked, in a few words a parent recognizes. */
const asked = (item: ItemEntry["item"]): string => {
  switch (item.type) {
    case "count-sounds": return `Count the sounds in "${item.word}"`;
    case "blend-sounds": return `Blend ${item.phonemes.join(" ")}`;
    case "build-word": return `Build "${item.word}"`;
    case "read-word": return `Read "${item.word}"`;
    case "find-word": return `Find the word "${item.word}"`;
    case "read-sentence": return `Read "${item.sentence}"`;
    case "read-aloud": return `Read aloud: "${item.sentence}"`;
    case "listen-and-answer": return item.question;
    case "count-objects": return `Count ${item.count} ${item.picture.label}`;
    case "compare-groups": return `Which has ${item.ask}: ${item.left} or ${item.right}?`;
    case "one-more-less": return `One ${item.change > 0 ? "more" : "less"} than ${item.start}`;
    case "place-on-line": return `Find ${item.target} on a line to ${item.max}`;
    case "number-line-jump": return `${item.start} ${item.change > 0 ? "+" : "−"} ${Math.abs(item.change)} on a line to ${item.max}`;
  }
};

/** A child's answer in words. */
const said = (item: ItemEntry["item"], answer: Answer): string => {
  switch (answer.kind) {
    case "number": return answer.path === undefined || answer.path.length === 0 ? String(answer.value) : `${answer.value} (jumped through ${answer.path.join(", ")})`;
    case "letters": return answer.letters.join("");
    case "observed": return { independent: "read it on their own", "with-help": "read it with help", "not-yet": "not yet" }[answer.result];
    case "choice": {
      if (item.type === "compare-groups") return answer.choice === "left" ? "the left group" : "the right group";
      const choice = "choices" in item && Array.isArray(item.choices) ? (item.choices as { key: string; text: string; picture?: { label: string } }[]).find((c) => c.key === answer.choice) : undefined;
      return choice?.picture?.label ?? choice?.text ?? answer.choice;
    }
  }
};

const ItemRow = ({ entry, onCorrect }: { entry: ItemEntry; onCorrect: (verdict: (typeof VERDICTS)[number]["verdict"]) => void }) => {
  const { item, response, correction } = entry;
  return (
    <li>
      <Surface className="flex flex-col gap-2 rounded-xl border border-kumo-hairline p-4">
        <span className="font-semibold">{asked(item)}</span>
        {response === undefined ? <Text variant="secondary">Not answered.</Text> : (
          <>
            <Text>{`Answered: ${response.answers.map((a) => said(item, a)).join(", then ")}`}</Text>
            <span className="flex flex-wrap gap-2">
              <Badge variant={response.independent ? "success" : response.correct ? "info" : "neutral"}>
                {response.independent ? "Right on the first try, no help" : response.correct ? "Right, with a retry or help" : "Not right yet"}
              </Badge>
              {response.hintUsed ? <Badge variant="neutral">Used the hint</Badge> : null}
              {response.adultHelped ? <Badge variant="neutral">Asked you for help</Badge> : null}
              <Badge variant="outline">{EVIDENCE_LABEL[response.evidence]}</Badge>
            </span>
            {correction === undefined ? null : <Text size="sm">{`You changed this to "${VERDICTS.find((v) => v.verdict === correction.verdict)!.label}". The original answer is kept.`}</Text>}
            <fieldset className="flex flex-wrap items-center gap-2">
              <legend className="sr-only">Correct this answer</legend>
              <span className="text-sm text-kumo-subtle">Correct it:</span>
              {VERDICTS.map(({ verdict, label }) => (
                <Button key={verdict} size="xs" variant="ghost" aria-pressed={correction?.verdict === verdict} onClick={() => onCorrect(verdict)}>{label}</Button>
              ))}
            </fieldset>
          </>
        )}
      </Surface>
    </li>
  );
};

/** One session, item by item: what was asked, what your child answered, the help used, and where the evidence came from. */
export const SessionPage = ({ learnerId, sessionId }: { learnerId: string; sessionId: string }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [detail, reload] = useQuery(`family-session:${sessionId}`, (client) => client.call("family.session", { params: { learnerId, sessionId } }));
  const [corrected, setCorrected] = useState<Detail | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  if (detail.status === "loading") return <LoadingSkeleton label="Loading this session" />;
  if (detail.status === "error") return <ErrorState error={detail.error} title="We couldn't load this session" onRetry={reload} />;
  const data = corrected ?? detail.data;
  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs>
        <Breadcrumbs.Link href={progressPath(learnerId)}>Progress</Breadcrumbs.Link>
        <Breadcrumbs.Separator />
        <Breadcrumbs.Current>{data.summary.title}</Breadcrumbs.Current>
      </Breadcrumbs>
      <PageHeading>{data.summary.title}</PageHeading>
      <Text>{data.summary.note}</Text>
      <Text variant="secondary" size="sm">If something here is wrong (a sibling answered, or you helped and it isn't marked), correct it. Corrections change progress; the original answer is always kept.</Text>
      {error === undefined ? null : <p role="alert" className="text-kumo-danger">{error}</p>}
      <ol className="flex flex-col gap-3">
        {data.items.map((entry) => (
          <ItemRow key={entry.item.key} entry={entry} onCorrect={(verdict) => {
            setError(undefined);
            api.call("family.correct", { params: { learnerId, sessionId }, body: { item: entry.item.key, verdict } }).then((next) => {
              setCorrected(next);
              announce("Correction saved");
            }, (caught: unknown) => setError(messageFor(caught)));
          }} />
        ))}
      </ol>
    </div>
  );
};
