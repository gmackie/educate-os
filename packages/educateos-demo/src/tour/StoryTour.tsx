import { useId } from "react";
import { Badge, Button, Text } from "@cloudflare/kumo";
import { ArrowLeftIcon, ArrowRightIcon, CaretDownIcon, CaretRightIcon, CheckCircleIcon, CircleIcon, PlayIcon } from "@phosphor-icons/react";
import { PresenterHelp } from "./PresenterHelp.tsx";
import type { PresenterKey } from "./presenter.ts";
import { STORY_STEPS } from "./storyTour.ts";

interface StoryTourProps {
  /** The step last opened, if any. */
  at: number | undefined;
  /** The steps opened so far, by index. */
  visited: ReadonlySet<number>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether the district is up, so a step can open in it. */
  ready: boolean;
  /** Opens step `index`: its persona's app, at its screen. */
  onGo: (index: number) => void;
  /** Presenter mode, when on: its shortcuts' help, which the "?" key toggles. */
  presenter?: { keys: readonly PresenterKey[]; helpOpen: boolean; onHelpOpenChange: (open: boolean) => void };
}

const PRESENTER_NOTE = "Keys do nothing while you type in a field. Each step signs you in as its person and opens their screen; Reset demo starts the district over.";

/**
 * The K-12 story tour (SCHO-324): a strip under the demo's banner that walks Northfield from a
 * first grader to the district office in eight screens. Collapsed, it names the next step and opens
 * it; open, it lists every step with what to point out. In presenter mode it shows only the titles,
 * and the number keys and arrows drive it.
 */
export const StoryTour = ({ at, visited, open, onOpenChange, ready, onGo, presenter }: StoryTourProps) => {
  const panelId = useId();
  const headingId = useId();
  const next = at === undefined ? 0 : at + 1;
  const current = at === undefined ? undefined : STORY_STEPS[at];

  return (
    <section aria-labelledby={headingId} className="border-b border-kumo-line bg-kumo-elevated px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          icon={open ? <CaretDownIcon aria-hidden /> : <CaretRightIcon aria-hidden />}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onOpenChange(!open)}
        >
          <span id={headingId}>K-12 tour</span>
        </Button>
        <Badge variant={visited.size === STORY_STEPS.length ? "success" : "secondary"}>{`${visited.size}/${STORY_STEPS.length}`}</Badge>
        {/* On a phone a step's title takes its own line under the controls, and the intro gives way. */}
        <span className="min-w-0 flex-1 max-sm:order-last max-sm:basis-full">
          <span className={current === undefined ? "max-sm:hidden" : ""}><Text size="sm" variant="secondary">
            {current === undefined
              ? "Five minutes, kindergarten to the district office: one screen a step."
              : `Step ${at! + 1} · ${current.band}: ${current.title}`}
          </Text></span>
        </span>
        {at !== undefined && (
          <Button size="sm" variant="ghost" shape="square" icon={<ArrowLeftIcon aria-hidden />} aria-label="Previous step" disabled={!ready || at === 0} onClick={() => onGo(at - 1)} />
        )}
        {next < STORY_STEPS.length && (
          <Button size="sm" variant="primary" icon={at === undefined ? <PlayIcon aria-hidden /> : <ArrowRightIcon aria-hidden />} disabled={!ready} onClick={() => onGo(next)}>
            {at === undefined ? "Start the tour" : "Next step"}
          </Button>
        )}
        {presenter !== undefined && <PresenterHelp open={presenter.helpOpen} onOpenChange={presenter.onHelpOpenChange} keys={presenter.keys} note={PRESENTER_NOTE} />}
      </div>
      {current !== undefined && presenter === undefined && !open && (
        <span className="max-sm:hidden"><Text size="sm">{current.say}</Text></span>
      )}
      {open && (
        <ol id={panelId} className="flex flex-col gap-3 py-2">
          {STORY_STEPS.map((step, index) => (
            <li key={step.id} aria-current={index === at ? "step" : undefined} className="flex items-start gap-2">
              {visited.has(index)
                ? <CheckCircleIcon aria-hidden weight="fill" size={20} className="mt-0.5 shrink-0 text-kumo-success" />
                : <CircleIcon aria-hidden size={20} className={`mt-0.5 shrink-0 ${index === next ? "text-kumo-brand" : "text-kumo-subtle"}`} />}
              <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                <Text bold={index === at}>
                  {`${index + 1}. ${step.band} · ${step.title}`}
                  <span className="sr-only">{visited.has(index) ? " (seen)" : " (not seen yet)"}</span>
                </Text>
                {presenter === undefined && <Text size="sm" variant="secondary">{step.say}</Text>}
              </div>
              <Button size="sm" variant="ghost" disabled={!ready} aria-label={`Go to step ${index + 1}`} onClick={() => onGo(index)}>Go</Button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};
