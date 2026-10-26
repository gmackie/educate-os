import { Badge, Button, Popover, Text } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, CheckCircleIcon, CircleIcon, ListChecksIcon, UserSwitchIcon } from "@phosphor-icons/react";
import type { Persona } from "./demoDistrict.ts";
import { JOURNEYS } from "./journeys.ts";

interface DemoBannerProps {
  /** Who the visitor is being, if anyone yet. */
  persona: Persona | undefined;
  done: ReadonlySet<string>;
  onSwitchPersona: () => void;
  onReset: () => void;
}

/**
 * The banner on every screen: what this is, who you are, and the way out of it. On a phone it
 * scrolls away with the page and its buttons show only their icons, so the app keeps the screen;
 * the apps' own headers name who is signed in.
 */
export const DemoBanner = ({ persona, done, onSwitchPersona, onReset }: DemoBannerProps) => (
  <header
    aria-label="Demo"
    className="z-40 flex items-center gap-x-4 gap-y-2 border-b border-kumo-line bg-kumo-elevated px-4 py-2 sm:sticky sm:top-0 sm:flex-wrap"
  >
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
      <Badge variant="primary">Demo</Badge>
      <Text size="sm">Fictional district · everything stays in your browser · AI is off</Text>
      {persona !== undefined && (
        <span className="max-sm:hidden">
          <Text size="sm" variant="secondary">{`You're ${persona.name} · ${persona.role}`}</Text>
        </span>
      )}
    </div>
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      {persona !== undefined && <JourneyChecklist persona={persona} done={done} />}
      {persona !== undefined && (
        <Button size="sm" icon={<UserSwitchIcon aria-hidden />} onClick={onSwitchPersona}>
          <span className="max-sm:sr-only">Switch persona</span>
        </Button>
      )}
      <Button size="sm" variant="ghost" icon={<ArrowCounterClockwiseIcon aria-hidden />} onClick={onReset}>
        <span className="max-sm:sr-only">Reset demo</span>
      </Button>
    </div>
  </header>
);

const JourneyChecklist = ({ persona, done }: { persona: Persona; done: ReadonlySet<string> }) => {
  const steps = JOURNEYS[persona.id];
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
