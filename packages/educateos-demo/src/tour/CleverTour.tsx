import { useId, useSyncExternalStore } from "react";
import { Badge, Button, Text } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, CaretDownIcon, CaretRightIcon, CheckCircleIcon, CircleIcon, ArrowBendDownRightIcon } from "@phosphor-icons/react";
import { CLEVER_TOUR_STEPS, type CleverTourStore, type TourStepId } from "./cleverTour.ts";
import { PresenterHelp } from "./PresenterHelp.tsx";

interface CleverTourProps {
  tour: CleverTourStore;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether the district is up, so the tour can take the visitor somewhere in it. */
  ready: boolean;
  /** Takes the visitor to where a step is done. */
  onShowMe: (step: TourStepId) => void;
  /** Presenter mode, when on: its jump, reset and shortcuts' help, which the "?" key toggles. */
  presenter?: {
    onJump: (step: TourStepId) => void;
    onReset: () => void;
    helpOpen: boolean;
    onHelpOpenChange: (open: boolean) => void;
  };
}

/**
 * The guided Clever tour (SCHO-279): a strip under the demo's banner, in the page's flow so it
 * never covers the apps. Collapsed, it names the step to do next; open, it lists every step with
 * what it shows and a way there. In presenter mode only the steps' titles stay, each with a jump.
 */
export const CleverTour = ({ tour, open, onOpenChange, ready, onShowMe, presenter }: CleverTourProps) => {
  const { done, facts, current } = useSyncExternalStore(tour.subscribe, tour.getSnapshot);
  const panelId = useId();
  const headingId = useId();
  const position = current === undefined ? CLEVER_TOUR_STEPS.length : CLEVER_TOUR_STEPS.indexOf(current) + 1;

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
          <span id={headingId}>Clever tour</span>
        </Button>
        <Badge variant={current === undefined ? "success" : "secondary"}>{`${done.size}/${CLEVER_TOUR_STEPS.length} done`}</Badge>
        <span className="min-w-0 flex-1">
          <Text size="sm" variant="secondary">
            {current === undefined ? "Tour finished: every step happened in this district." : `Step ${position}: ${current.title}`}
          </Text>
        </span>
        {!open && current !== undefined && (
          <Button size="sm" variant="secondary" disabled={!ready} onClick={() => (presenter === undefined ? onShowMe(current.id) : presenter.onJump(current.id))}>
            {presenter === undefined ? current.showMe : "Jump"}
          </Button>
        )}
        {presenter !== undefined && (
          <>
            <Button size="sm" variant="ghost" icon={<ArrowCounterClockwiseIcon aria-hidden />} onClick={presenter.onReset}>Start over</Button>
            <PresenterHelp open={presenter.helpOpen} onOpenChange={presenter.onHelpOpenChange} />
          </>
        )}
      </div>
      {open && (
        <ol id={panelId} className="flex flex-col gap-3 py-2">
          {CLEVER_TOUR_STEPS.map((step, index) => {
            const isDone = done.has(step.id);
            return (
              <li key={step.id} aria-current={step === current ? "step" : undefined} className="flex items-start gap-2">
                {isDone
                  ? <CheckCircleIcon aria-hidden weight="fill" size={20} className="mt-0.5 shrink-0 text-kumo-success" />
                  : <CircleIcon aria-hidden size={20} className={`mt-0.5 shrink-0 ${step === current ? "text-kumo-brand" : "text-kumo-subtle"}`} />}
                <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                  <Text bold={step === current}>
                    {`${index + 1}. ${step.title}`}
                    <span className="sr-only">{isDone ? " (done)" : " (not done yet)"}</span>
                  </Text>
                  {presenter === undefined && <Text size="sm" variant="secondary">{step.explain(facts)}</Text>}
                </div>
                {presenter === undefined ? (
                  <Button size="sm" variant="ghost" icon={<ArrowBendDownRightIcon aria-hidden />} disabled={!ready} aria-label={`Show me: ${step.showMe}`} onClick={() => onShowMe(step.id)}>
                    <span className="max-sm:sr-only">Show me</span>
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" disabled={!ready} aria-label={`Jump to step ${index + 1}`} onClick={() => presenter.onJump(step.id)}>Jump</Button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
};
