import { useSyncExternalStore } from "react";
import { Badge, Button, LinkButton, Popover, Text } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, ArrowUpRightIcon, CheckCircleIcon, CircleIcon, ListChecksIcon, MapTrifoldIcon, UserSwitchIcon } from "@phosphor-icons/react";
import type { DistrictInfo, Persona } from "./districts/index.ts";
import { journeyOf } from "./journeys.ts";

/** The demo's home, which visitors who came straight to the demo can find their way to. */
export const SITE_HOME = "https://educateos.io/";
/** Where a visitor tells us they are interested. */
export const SITE_INTEREST = "https://educateos.io/interest/";
import { CLEVER_TOUR_STEPS, type CleverTourStore } from "./tour/cleverTour.ts";

interface DemoBannerProps {
  /** The district the visitor is in. */
  info: DistrictInfo;
  /** Who the visitor is being, if anyone yet. */
  persona: Persona | undefined;
  done: ReadonlySet<string>;
  onSwitchPersona: () => void;
  onReset: () => void;
  /** The district's guided tour, when it has one: its progress, and the toggle of its panel. */
  tour?: { store: CleverTourStore; open: boolean; onToggle: () => void };
}

/**
 * The banner on every screen: what this is, who you are, and the way out of it. On a phone it
 * scrolls away with the page, keeps to one short line and its buttons show only their icons, so the
 * app keeps the screen; the apps' own headers name who is signed in. A district's notice, such as
 * Cedar Valley's that its Clever is simulated, stays in it on every screen and every size.
 */
export const DemoBanner = ({ info, persona, done, onSwitchPersona, onReset, tour }: DemoBannerProps) => (
  <header
    aria-label="Demo"
    className="z-40 flex items-center gap-x-4 gap-y-2 border-b border-kumo-line bg-kumo-elevated px-4 py-1 sm:sticky sm:top-0 sm:flex-wrap sm:py-2"
  >
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
      <Badge variant="primary">Demo</Badge>
      {/* A phone gets the short form, on one line beside the buttons. */}
      <span className="sm:hidden"><Text size="xs">Fictional · in your browser · AI simulated</Text></span>
      <span className="max-sm:hidden"><Text size="sm">Fictional district · everything stays in your browser · AI tutors are simulated</Text></span>
      <span className="max-sm:hidden">
        <Text size="sm" variant="secondary">{info.name}</Text>
      </span>
      {persona !== undefined && (
        <span className="max-sm:hidden">
          <Text size="sm" variant="secondary">{`You're ${persona.name} · ${persona.role}`}</Text>
        </span>
      )}
      {info.notice !== undefined && (
        <span className="basis-full">
          <Text size="sm" variant="secondary">{info.notice}</Text>
        </span>
      )}
    </div>
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      {tour !== undefined && <TourProgress {...tour} />}
      {persona !== undefined && <JourneyChecklist persona={persona} done={done} />}
      {persona !== undefined && (
        <Button size="sm" icon={<UserSwitchIcon aria-hidden />} onClick={onSwitchPersona}>
          <span className="max-sm:sr-only">Switch persona</span>
        </Button>
      )}
      <Button size="sm" variant="ghost" icon={<ArrowCounterClockwiseIcon aria-hidden />} onClick={onReset}>
        <span className="max-sm:sr-only">Reset demo</span>
      </Button>
      {persona === undefined && (
        <>
          <LinkButton size="sm" variant="secondary" href={SITE_INTEREST}>Share your interest</LinkButton>
          <LinkButton size="sm" variant="ghost" href={SITE_HOME} icon={<ArrowUpRightIcon aria-hidden />} aria-label="Back to educateos.io">
            <span className="max-sm:hidden">educateos.io</span>
          </LinkButton>
        </>
      )}
    </div>
  </header>
);

const JourneyChecklist = ({ persona, done }: { persona: Persona; done: ReadonlySet<string> }) => {
  const steps = journeyOf(persona);
  const finished = steps.filter((step) => done.has(step.id)).length;
  return (
    <Popover>
      <Popover.Trigger render={<Button size="sm" variant="primary" icon={<ListChecksIcon aria-hidden />} />}>
        <span className="max-sm:sr-only">Things to try </span>
        {`${finished}/${steps.length}`}
      </Popover.Trigger>
      <Popover.Content>
        <Popover.Title>{`Things to try as ${persona.name}`}</Popover.Title>
        <ul className="mt-2 flex flex-col gap-2">
          {steps.map((step) => {
            const isDone = done.has(step.id);
            return (
              <li key={step.id} className="flex items-start gap-2">
                {isDone
                  ? <CheckCircleIcon aria-hidden weight="fill" size={20} className="shrink-0 text-kumo-success" />
                  : <CircleIcon aria-hidden size={20} className="shrink-0 text-kumo-subtle" />}
                <Text>
                  {step.label}
                  <span className="sr-only">{isDone ? " (done)" : " (not done yet)"}</span>
                </Text>
              </li>
            );
          })}
        </ul>
        <Popover.Description>
          <span className="mt-3 block max-w-xs">Switch persona to see the other side: work a student submits shows up for their teacher.</span>
        </Popover.Description>
      </Popover.Content>
    </Popover>
  );
};

/** The tour's progress, as the journeys' checklist shows theirs; it opens and closes the tour's panel. */
const TourProgress = ({ store, open, onToggle }: { store: CleverTourStore; open: boolean; onToggle: () => void }) => {
  const { done } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <Button size="sm" variant={open ? "secondary" : "primary"} icon={<MapTrifoldIcon aria-hidden />} aria-pressed={open} onClick={onToggle}>
      <span className="max-sm:sr-only">Clever tour </span>
      {`${done.size}/${CLEVER_TOUR_STEPS.length}`}
    </Button>
  );
};
