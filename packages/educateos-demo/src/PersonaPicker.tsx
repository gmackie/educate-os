import type { ReactNode } from "react";
import { Loader, Tabs, Text } from "@cloudflare/kumo";
import { BackpackIcon, BuildingsIcon, ChalkboardTeacherIcon, UsersThreeIcon, type Icon } from "@phosphor-icons/react";
import type { DistrictState } from "./DemoApp.tsx";
import { DISTRICTS, type DistrictInfo, type DistrictKey, type PersonaId } from "./districts/index.ts";
import { JOURNEYS } from "./journeys.ts";

const ICON: Record<PersonaId, Icon> = {
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

/**
 * Where the demo starts: which district, and who to be. Picking someone works before the district
 * is up; they wait for it.
 */
export const PersonaPicker = ({ info, district, done, onChoose, onSwitchDistrict, portal }: PersonaPickerProps) => (
  <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 md:py-12">
    <div className="flex flex-col gap-2">
      <Text as="h1" variant="heading" size="lg">Try EducateOS</Text>
      <div role="group" aria-label="District" className="self-start">
        <Tabs
          tabs={DISTRICTS.map((d) => ({ value: d.key, label: `${d.shortName} · ${d.integrations}` }))}
          value={info.key}
          onValueChange={(key) => onSwitchDistrict(key as DistrictKey)}
        />
      </div>
      <Text variant="secondary">
        {`${info.name} ${info.introduction} `}
        It runs entirely in your browser, so nothing you do is sent anywhere, and AI is turned off. Choose who to be. You can
        switch at any time, and what one person does, the others see.
      </Text>
      {district.status === "booting" && (
        <div role="status" className="flex items-center gap-2">
          <Loader size="sm" />
          <Text variant="secondary" size="sm">Setting up the district…</Text>
        </div>
      )}
    </div>
    {portal ?? <ul className="grid gap-4 sm:grid-cols-2">
      {info.personas.map((persona) => {
        const PersonaIcon = ICON[persona.id];
        const steps = JOURNEYS[persona.id];
        const finished = steps.filter((step) => done.has(step.id)).length;
        return (
          <li key={persona.id} className="flex">
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
                {finished > 0 && <Text as="span" variant="secondary" size="sm">{`${finished} of ${steps.length} things to try done`}</Text>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>}
  </main>
);
