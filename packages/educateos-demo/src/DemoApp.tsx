import { useEffect, useState } from "react";
import { ThemeProvider, storedThemeMode } from "@gadgets/ui/theme";
import { bootDemoDistrict, PERSONAS, type DemoDistrict, type PersonaId } from "./demoDistrict.ts";
import { DemoBanner } from "./DemoBanner.tsx";
import { PersonaPicker } from "./PersonaPicker.tsx";
import { PersonaWorkspace } from "./PersonaWorkspace.tsx";

/** Where the in-page district stands. */
export type DistrictState =
  | { status: "booting" }
  | { status: "ready"; district: DemoDistrict }
  | { status: "failed"; error: unknown };

// The apps' own theme setting (SCHO-217): the system's mode until the visitor picks one in any app's
// header, then that choice for every persona, kept in this browser like the rest of the demo.
const THEME = storedThemeMode("educateos:theme-mode");

/** Drops the hash route the last persona's app left, so the next one opens at its home. */
const clearAppRoute = () => window.history.replaceState(null, "", window.location.pathname + window.location.search);

/**
 * The demo: one district booted in the page and shared by every persona, so what one does the
 * others see. Reset boots a fresh one. Nothing is kept once the tab closes.
 */
export const DemoApp = () => {
  const [generation, setGeneration] = useState(0);
  const [district, setDistrict] = useState<DistrictState>({ status: "booting" });
  const [personaId, setPersonaId] = useState<PersonaId>();
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let live = true;
    bootDemoDistrict().then(
      (booted) => live && setDistrict({ status: "ready", district: booted }),
      (error: unknown) => live && setDistrict({ status: "failed", error }),
    );
    return () => {
      live = false;
    };
  }, [generation]);

  const persona = PERSONAS.find((p) => p.id === personaId);
  const choose = (id: PersonaId | undefined) => {
    clearAppRoute();
    setPersonaId(id);
    window.scrollTo(0, 0);
  };
  const reset = () => {
    choose(undefined);
    setDone(new Set());
    setDistrict({ status: "booting" });
    setGeneration((n) => n + 1);
  };
  const markDone = (ids: readonly string[]) => setDone((previous) => new Set([...previous, ...ids]));

  return (
    <ThemeProvider source={THEME}>
      <div className="flex min-h-dvh flex-col bg-kumo-base text-kumo-default">
        <DemoBanner persona={persona} done={done} onSwitchPersona={() => choose(undefined)} onReset={reset} />
        <div className="flex-1">
          {persona === undefined ? (
            <PersonaPicker district={district} done={done} onChoose={choose} />
          ) : (
            <PersonaWorkspace key={`${generation}:${persona.id}`} district={district} persona={persona} onStepsDone={markDone} />
          )}
        </div>
      </div>
    </ThemeProvider>
  );
};
