import type { ReactNode } from "react";
import { Loader, Tabs, Text } from "@cloudflare/kumo";
import { BackpackIcon, BuildingsIcon, ChalkboardTeacherIcon, UsersThreeIcon, type Icon } from "@phosphor-icons/react";
import type { DistrictState } from "./DemoApp.tsx";
import { DISTRICTS, type DistrictInfo, type DistrictKey, type Persona, type PersonaId, type PersonaKind } from "./districts/index.ts";
import { journeyOf } from "./journeys.ts";

const ICON: Record<PersonaKind, Icon> = {
  student: BackpackIcon,
  teacher: ChalkboardTeacherIcon,
  guardian: UsersThreeIcon,
  admin: BuildingsIcon,
};

interface PersonaPickerProps {
  info: DistrictInfo;
  district: DistrictState;
  /** The journey steps done so far, to show each persona's progress. */
  done: ReadonlySet<string>;
  onChoose: (persona: PersonaId) => void;
  onSwitchDistrict: (district: DistrictKey) => void;
  /** The district's own way in, such as Cedar Valley's Clever portal, in place of the personas. */
  portal?: ReactNode;
}

/** One person to be: who they are, what they can do, and what to look at as them. */
const PersonaCard = ({ persona, done, onChoose }: { persona: Persona; done: ReadonlySet<string>; onChoose: (persona: PersonaId) => void }) => {
  const PersonaIcon = ICON[persona.kind];
  const steps = journeyOf(persona);
  const finished = steps.filter((step) => done.has(step.id)).length;
  return (
    <li className="flex">
      <button
        type="button"
        onClick={() => onChoose(persona.id)}
        className="flex w-full cursor-pointer items-start gap-4 rounded-lg border border-kumo-line bg-kumo-elevated p-4 text-left hover:border-kumo-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
      >
        <PersonaIcon aria-hidden size={32} className="shrink-0 text-kumo-brand" />
        <span className="flex flex-col gap-1">
          <Text as="span" variant="heading">{persona.role}</Text>
          <Text as="span" variant="secondary" size="sm">{persona.name}</Text>
          <Text as="span">{persona.description}</Text>
          {persona.lookFor !== undefined && <Text as="span" variant="secondary" size="sm">{`Look for: ${persona.lookFor}.`}</Text>}
          {finished > 0 && <Text as="span" variant="secondary" size="sm">{`${finished} of ${steps.length} things to try done`}</Text>}
        </span>
      </button>
    </li>
  );
};

/** The personas, under their district's sections when it has them, else in one list. */
const Personas = ({ info, done, onChoose }: Pick<PersonaPickerProps, "info" | "done" | "onChoose">) => {
  if (info.sections === undefined) {
    return (
      <ul className="grid gap-4 sm:grid-cols-2">
        {info.personas.map((persona) => <PersonaCard key={persona.id} persona={persona} done={done} onChoose={onChoose} />)}
      </ul>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      {info.sections.map((section) => {
        const people = info.personas.filter((p) => p.section === section.key);
        if (people.length === 0) return null;
        const id = `personas-${section.key}`;
        return (
          <section key={section.key} aria-labelledby={id} className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <Text as="h2" variant="heading" id={id}>{section.title}</Text>
              <Text variant="secondary" size="sm">{section.description}</Text>
            </div>
            <ul className="grid gap-4 sm:grid-cols-2">
              {people.map((persona) => <PersonaCard key={persona.id} persona={persona} done={done} onChoose={onChoose} />)}
            </ul>
          </section>
        );
      })}
    </div>
  );
};

/**
 * Where the demo starts: which district, and who to be. Picking someone works before the district
 * is up; they wait for it.
 */
export const PersonaPicker = ({ info, district, done, onChoose, onSwitchDistrict, portal }: PersonaPickerProps) => (
  <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 md:py-12">
    <div className="flex flex-col gap-2">
      <Text as="h1" variant="heading" size="lg">Try EducateOS</Text>
      {/* Both districts' full labels are wider than a phone, so there each tab names only its district. */}
      <div role="group" aria-label="District" className="max-w-full self-start">
        <Tabs
          tabs={DISTRICTS.map((d) => ({
            value: d.key,
            label: (
              <>
                {d.shortName}
                <span className="max-sm:hidden">{` · ${d.integrations}`}</span>
              </>
            ),
          }))}
          value={info.key}
          onValueChange={(key) => onSwitchDistrict(key as DistrictKey)}
        />
      </div>
      <Text variant="secondary">
        {`${info.name} ${info.introduction} `}
        It runs entirely in your browser, so nothing you do is sent anywhere. Its AI tutors are simulated: on the live AI
        district they run on real AI, with Hall Monitor screening every message. Choose who to be. You can switch at any
        time, and what one person does, the others see.
      </Text>
      {district.status === "booting" && (
        <div role="status" className="flex items-center gap-2">
          <Loader size="sm" />
          <Text variant="secondary" size="sm">Setting up the district…</Text>
        </div>
      )}
    </div>
    {portal ?? <Personas info={info} done={done} onChoose={onChoose} />}
  </main>
);
