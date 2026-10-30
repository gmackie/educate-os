import { useEffect, useState } from "react";
import { ThemeProvider, storedThemeMode } from "@gadgets/ui/theme";
import { districtFromSearch, districtInfo, type DemoDistrict, type DistrictKey, type PersonaId } from "./districts/index.ts";
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

/** Names `key` in the page's query string, so a link or a reload opens the same district. */
const showDistrictInUrl = (key: DistrictKey) => {
  const search = new URLSearchParams(window.location.search);
  if (key === "northfield") search.delete("district");
  else search.set("district", key);
  const query = search.toString();
  window.history.replaceState(null, "", window.location.pathname + (query === "" ? "" : `?${query}`));
};

/**
 * The demo: one district booted in the page and shared by every persona, so what one does the
 * others see. Reset boots a fresh copy of it; switching district boots the other. Nothing is kept
 * once the tab closes.
 */
export const DemoApp = () => {
  const [districtKey, setDistrictKey] = useState(() => districtFromSearch(window.location.search));
  const [generation, setGeneration] = useState(0);
  const [district, setDistrict] = useState<DistrictState>({ status: "booting" });
  const [personaId, setPersonaId] = useState<PersonaId>();
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const info = districtInfo(districtKey);

  useEffect(() => {
    let live = true;
    districtInfo(districtKey).boot().then(
      (booted) => live && setDistrict({ status: "ready", district: booted }),
      (error: unknown) => live && setDistrict({ status: "failed", error }),
    );
    return () => {
      live = false;
    };
  }, [districtKey, generation]);

  const persona = info.personas.find((p) => p.id === personaId);
  const choose = (id: PersonaId | undefined) => {
    clearAppRoute();
    setPersonaId(id);
    window.scrollTo(0, 0);
  };
  const startOver = () => {
    choose(undefined);
    setDone(new Set());
    setDistrict({ status: "booting" });
  };
  const reset = () => {
    startOver();
    setGeneration((n) => n + 1);
  };
  const switchDistrict = (key: DistrictKey) => {
    if (key === districtKey) return;
    showDistrictInUrl(key);
    startOver();
    setDistrictKey(key);
  };
  const markDone = (ids: readonly string[]) => setDone((previous) => new Set([...previous, ...ids]));

  return (
    <ThemeProvider source={THEME}>
      <div className="flex min-h-dvh flex-col bg-kumo-base text-kumo-default">
        <DemoBanner info={info} persona={persona} done={done} onSwitchPersona={() => choose(undefined)} onReset={reset} />
        <div className="flex-1">
          {persona === undefined ? (
            <PersonaPicker info={info} district={district} done={done} onChoose={choose} onSwitchDistrict={switchDistrict} />
          ) : (
            <PersonaWorkspace
              key={`${districtKey}:${generation}:${persona.id}`}
              info={info}
              district={district}
              persona={persona}
              onStepsDone={markDone}
              onChoose={choose}
            />
          )}
        </div>
      </div>
    </ThemeProvider>
  );
};
