import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Loader } from "@cloudflare/kumo";
import { ThemeProvider, storedThemeMode } from "@gadgets/ui/theme";
import { CleverSide } from "./clever/CleverSide.tsx";
import { cleverSideOf } from "./clever/cleverSide.ts";
import { ROSTER_SYNC_ROUTE, districtFromSearch, districtInfo, type DemoDistrict, type DistrictKey, type PersonaId } from "./districts/index.ts";
import { DemoBanner } from "./DemoBanner.tsx";
import { PersonaPicker } from "./PersonaPicker.tsx";
import { PersonaWorkspace } from "./PersonaWorkspace.tsx";
import type { PortalSignIn } from "./clever/Portal.tsx";
import { CleverTour } from "./tour/CleverTour.tsx";
import { CleverTourStore, jumpTo, showMe, type TourActions, type TourStepId } from "./tour/cleverTour.ts";
import { presenterFromSearch, usePresenterKeys } from "./tour/presenter.ts";

// Cedar Valley's Clever portal brings the control plane's launch, jose and the Clever sign-in fake,
// so it loads only when a visitor opens Cedar Valley, like the district itself.
const CleverPortal = lazy(() => import("./clever/Portal.tsx").then((m) => ({ default: m.CleverPortal })));
const UnderTheHood = lazy(() => import("./clever/UnderTheHood.tsx").then((m) => ({ default: m.UnderTheHood })));

/** Whether a district's people come in through its Clever portal rather than the persona picker. */
const signsInThroughPortal = (key: DistrictKey) => key === "cedarvalley";

/** Whether a district has the guided Clever tour (SCHO-279). */
const hasCleverTour = (key: DistrictKey) => key === "cedarvalley";

/** A visit to the portal a screen, the tour or a presenter's key sent the visitor on, signed in to it as `persona`. */
interface PortalVisit {
  persona: PersonaId;
  /** The hash route their app opens at once the portal has signed them in. */
  route?: string;
  /** Whether the portal opens EducateOS itself, as presenter mode's keys have it. */
  launch: boolean;
  /** Tells visits apart, so each one opens the portal afresh. */
  n: number;
}

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
 * every screen, where the visitor changes the district in Clever, and a guided tour across its
 * people, which `?presenter` turns into presenter mode.
 */
export const DemoApp = () => {
  const [districtKey, setDistrictKey] = useState(() => districtFromSearch(window.location.search));
  const [presenter] = useState(() => presenterFromSearch(window.location.search));
  const [generation, setGeneration] = useState(0);
  const [district, setDistrict] = useState<DistrictState>({ status: "booting" });
  const [personaId, setPersonaId] = useState<PersonaId>();
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  // Each persona's portal sign-in, in a district entered through its portal, and the visit to the
  // portal a screen or the tour sent the visitor on, to sign someone in.
  const [signIns, setSignIns] = useState<Partial<Record<PersonaId, PortalSignIn>>>({});
  const [portalVisit, setPortalVisit] = useState<PortalVisit>();
  const visits = useRef(0);
  const [tour, setTour] = useState(() => new CleverTourStore());
  const [tourOpen, setTourOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  // Counts the tour's requests to open the teacher's "Where grades land" panel.
  const [gradesRequest, setGradesRequest] = useState(0);
  const info = districtInfo(districtKey);
  const tourOn = hasCleverTour(districtKey);

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

  // The tour follows the district's own hooks: its syncs, the Clever side's changes and the
  // passback gate's events. The portal's and the apps' hooks are passed to them below.
  useEffect(() => {
    if (!tourOn || district.status !== "ready") return;
    const booted = district.district;
    const unsubscribes = [
      booted.roster?.onSync((result) => tour.synced(result)),
      cleverSideOf(booted)?.onChange((change) => tour.cleverChanged(change)),
      booted.grades?.subscribe((event) => event !== undefined && tour.graded(event)),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe?.();
    };
  }, [tourOn, district, tour]);

  const persona = info.personas.find((p) => p.id === personaId);
  /** Sends the visitor to the portal, signed in to it as `id`. */
  const visitPortal = (id: PersonaId, { route, launch = false }: { route?: string; launch?: boolean } = {}) => {
    setAppRoute();
    visits.current += 1;
    setPortalVisit({ persona: id, ...(route === undefined ? {} : { route }), launch, n: visits.current });
    setPersonaId(undefined);
    window.scrollTo(0, 0);
  };
  const choose = (id: PersonaId | undefined, route?: string) => {
    // Through the portal, someone not yet signed in goes to it, signed in to it as them, and their
    // app opens at `route` once the portal has signed them in.
    if (id !== undefined && signsInThroughPortal(districtKey) && signIns[id] === undefined) return visitPortal(id, route === undefined ? {} : { route });
    setAppRoute(route);
    setPortalVisit(undefined);
    setPersonaId(id);
    window.scrollTo(0, 0);
  };
  const signedIn = (id: PersonaId, signIn: PortalSignIn) => {
    setSignIns((previous) => ({ ...previous, [id]: signIn }));
    tour.signedIn(id);
    setAppRoute(id === portalVisit?.persona ? portalVisit.route : undefined);
    setPortalVisit(undefined);
    setPersonaId(id);
    window.scrollTo(0, 0);
  };
  const startOver = () => {
    choose(undefined);
    setSignIns({});
    setDone(new Set());
    setDistrict({ status: "booting" });
    setTour(new CleverTourStore());
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
  // Opens a persona's app at `route`, signing them in through the portal first if they have no
  // session yet, as a click on the portal's EducateOS tile would.
  const openApp = (id: PersonaId, { route, grades = false }: { route?: string; grades?: boolean } = {}) => {
    if (grades) setGradesRequest((n) => n + 1);
    if (id === personaId) {
      if (route !== undefined) window.location.hash = route;
      return;
    }
    if (signsInThroughPortal(districtKey) && signIns[id] === undefined) return visitPortal(id, { ...(route === undefined ? {} : { route }), launch: true });
    choose(id, route);
  };

  const tourActions: TourActions = {
    openPortalAs: (id) => visitPortal(id),
    openApp,
    openCleverSide: () => setSideOpen(true),
    teacherClassRoute: async () => {
      if (district.status !== "ready") return undefined;
      const classes = await district.district.grades?.classes();
      const earthScience = classes?.find((c) => c.title === "Earth Science 8");
      return earthScience === undefined ? undefined : `#/classes/${encodeURIComponent(earthScience.offeringId)}/submissions`;
    },
    ensureFirstSync: async () => {
      const roster = district.status === "ready" ? district.district.roster : undefined;
      if (roster !== undefined && !roster.synced()) await roster.sync();
    },
  };
  const presenting = presenter && tourOn;
  usePresenterKeys(presenting, (command) => {
    if (command.kind === "help") setHelpOpen((open) => !open);
    else if (district.status === "ready") visitPortal(command.persona, { launch: true });
  });

  return (
    <ThemeProvider source={THEME}>
      <div className="flex min-h-dvh flex-col bg-kumo-base text-kumo-default">
        <DemoBanner
          info={info}
          persona={persona}
          done={done}
          onSwitchPersona={() => choose(undefined)}
          onReset={reset}
          {...(tourOn ? { tour: { store: tour, open: tourOpen, onToggle: () => setTourOpen(!tourOpen) } } : {})}
        />
        {tourOn && (
          <CleverTour
            tour={tour}
            open={tourOpen}
            onOpenChange={setTourOpen}
            ready={district.status === "ready"}
            onShowMe={(step: TourStepId) => void showMe(step, tourActions)}
            {...(presenting ? { presenter: { onJump: (step: TourStepId) => void jumpTo(step, tourActions), onReset: reset, helpOpen, onHelpOpenChange: setHelpOpen } } : {})}
          />
        )}
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
                      key={`${districtKey}:${generation}:${portalVisit?.n ?? ""}`}
                      info={info}
                      district={district}
                      {...(portalVisit === undefined ? {} : { initialPersonaId: portalVisit.persona, launchOnOpen: portalVisit.launch })}
                      onSignedIn={signedIn}
                      onTileClick={(id) => tour.tileClicked(id)}
                      onHop={(hop) => tour.hop(hop)}
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
                  gradesRequest={gradesRequest}
                  {...(tourOn ? { onResponse: (request: Request, status: number) => tour.responded(persona.id, request, status) } : {})}
                  onChoose={choose}
                />
              </>
            )}
          </div>
          {cleverSide !== undefined && (
            <CleverSide
              side={cleverSide}
              admin={{ name: admin.name, current: personaId === "admin" }}
              onOpenRosterSync={() => openApp("admin", { route: ROSTER_SYNC_ROUTE })}
              expansion={{ open: sideOpen, onOpenChange: setSideOpen }}
            />
          )}
        </div>
      </div>
    </ThemeProvider>
  );
};
