import { lazy, Suspense, useEffect, useState } from "react";
import { Loader } from "@cloudflare/kumo";
import { ThemeProvider, storedThemeMode } from "@gadgets/ui/theme";
import { CleverSide } from "./clever/CleverSide.tsx";
import { cleverSideOf } from "./clever/cleverSide.ts";
import { ROSTER_SYNC_ROUTE, districtFromSearch, districtInfo, type DemoDistrict, type DistrictKey, type PersonaId } from "./districts/index.ts";
import { DemoBanner } from "./DemoBanner.tsx";
import { PersonaPicker } from "./PersonaPicker.tsx";
import { PersonaWorkspace } from "./PersonaWorkspace.tsx";
import type { PortalSignIn } from "./clever/Portal.tsx";

// Cedar Valley's Clever portal brings the control plane's launch, jose and the Clever sign-in fake,
// so it loads only when a visitor opens Cedar Valley, like the district itself.
const CleverPortal = lazy(() => import("./clever/Portal.tsx").then((m) => ({ default: m.CleverPortal })));
const UnderTheHood = lazy(() => import("./clever/UnderTheHood.tsx").then((m) => ({ default: m.UnderTheHood })));

/** Whether a district's people come in through its Clever portal rather than the persona picker. */
const signsInThroughPortal = (key: DistrictKey) => key === "cedarvalley";

/** Where the in-page district stands. */
export type DistrictState =
  | { status: "booting" }
  | { status: "ready"; district: DemoDistrict }
  | { status: "failed"; error: unknown };

// The apps' own theme setting (SCHO-217): the system's mode until the visitor picks one in any app's
// header, then that choice for every persona, kept in this browser like the rest of the demo.
const THEME = storedThemeMode("educateos:theme-mode");

/** Sets the hash route the next persona's app opens at, or drops the last one's so it opens at its home. */
const setAppRoute = (route = "") => window.history.replaceState(null, "", window.location.pathname + window.location.search + route);

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
 * once the tab closes. A district rostered from the in-page Clever has its Clever side beside
 * every screen, where the visitor changes the district in Clever.
 */
export const DemoApp = () => {
  const [districtKey, setDistrictKey] = useState(() => districtFromSearch(window.location.search));
  const [generation, setGeneration] = useState(0);
  const [district, setDistrict] = useState<DistrictState>({ status: "booting" });
  const [personaId, setPersonaId] = useState<PersonaId>();
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  // Each persona's portal sign-in, in a district entered through its portal, and whom the portal
  // opens signed in as when a screen sends the visitor there to sign someone in, with the route
  // their app then opens at.
  const [signIns, setSignIns] = useState<Partial<Record<PersonaId, PortalSignIn>>>({});
  const [portalPersonaId, setPortalPersonaId] = useState<PersonaId>();
  const [portalRoute, setPortalRoute] = useState<string>();
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
  const choose = (id: PersonaId | undefined, route?: string) => {
    // Through the portal, someone not yet signed in goes to it, signed in to it as them, and their
    // app opens at `route` once the portal has signed them in.
    const viaPortal = id !== undefined && signsInThroughPortal(districtKey) && signIns[id] === undefined;
    setAppRoute(viaPortal ? undefined : route);
    setPortalPersonaId(viaPortal ? id : undefined);
    setPortalRoute(viaPortal ? route : undefined);
    setPersonaId(viaPortal ? undefined : id);
    window.scrollTo(0, 0);
  };
  const signedIn = (id: PersonaId, signIn: PortalSignIn) => {
    setSignIns((previous) => ({ ...previous, [id]: signIn }));
    setAppRoute(id === portalPersonaId ? portalRoute : undefined);
    setPortalPersonaId(undefined);
    setPortalRoute(undefined);
    setPersonaId(id);
    window.scrollTo(0, 0);
  };
  const startOver = () => {
    choose(undefined);
    setSignIns({});
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
  const cleverSide = district.status === "ready" ? cleverSideOf(district.district) : undefined;
  const admin = info.personas.find((p) => p.id === "admin")!;
  // As the administrator: straight there if the visitor is them, else through the portal's sign-in.
  const openRosterSync = () => {
    if (personaId === "admin") window.location.hash = ROSTER_SYNC_ROUTE;
    else choose("admin", ROSTER_SYNC_ROUTE);
  };

  return (
    <ThemeProvider source={THEME}>
      <div className="flex min-h-dvh flex-col bg-kumo-base text-kumo-default">
        <DemoBanner info={info} persona={persona} done={done} onSwitchPersona={() => choose(undefined)} onReset={reset} />
        <div className="flex flex-1 max-lg:flex-col">
          <div className="min-w-0 flex-1">
            {persona === undefined ? (
              <PersonaPicker
                info={info}
                district={district}
                done={done}
                onChoose={choose}
                onSwitchDistrict={switchDistrict}
                portal={signsInThroughPortal(districtKey) ? (
                  <Suspense fallback={<Loader size="sm" />}>
                    <CleverPortal
                      key={`${districtKey}:${generation}:${portalPersonaId ?? ""}`}
                      info={info}
                      district={district}
                      {...(portalPersonaId === undefined ? {} : { initialPersonaId: portalPersonaId })}
                      onSignedIn={signedIn}
                    />
                  </Suspense>
                ) : undefined}
              />
            ) : (
              <>
                {signIns[persona.id] !== undefined && (
                  <div className="px-4 pt-4">
                    <Suspense fallback={null}>
                      <UnderTheHood hops={signIns[persona.id]!.hops} />
                    </Suspense>
                  </div>
                )}
                <PersonaWorkspace
                  key={`${districtKey}:${generation}:${persona.id}`}
                  info={info}
                  district={district}
                  persona={persona}
                  {...(signIns[persona.id] === undefined ? {} : { bearer: signIns[persona.id]!.session })}
                  onStepsDone={markDone}
                  onChoose={choose}
                />
              </>
            )}
          </div>
          {cleverSide !== undefined && (
            <CleverSide side={cleverSide} admin={{ name: admin.name, current: personaId === "admin" }} onOpenRosterSync={openRosterSync} />
          )}
        </div>
      </div>
    </ThemeProvider>
  );
};
