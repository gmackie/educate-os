// The guided Clever tour of Cedar Valley (SCHO-279): one journey across the district's people, from
// the portal to a grade landing in a gradebook. Like the personas' journeys (`../journeys.ts`), a
// step is done when the real thing happens: the portal's sign-in hooks, the roster's syncs, the
// Clever side's changes, the teacher's requests and the passback gate's events, never a button
// that claims it. Types only come from the Clever and grade modules, so this loads with the page.
import type { PendingChange } from "../clever/cleverSide.ts";
import type { InstantLoginHop } from "../clever/instantLogin.ts";
import type { PersonaId, RosterSyncResult } from "../districts/index.ts";
import type { GradeEvent, GradeRouteKind } from "../grades/types.ts";
import { journeyStep, requestDoes } from "../journeys.ts";

/** The tour's steps, in order. */
export type TourStepId = "portal" | "sign-in" | "first-sync" | "clever-change" | "delta-sync" | "teacher-grade" | "grade-out";

/** How much of one kind of record a sync changed. */
interface Changed {
  added: number;
  updated: number;
  deactivated: number;
}

/** What the tour has seen happen, which its explanations report rather than assume. */
export interface TourFacts {
  /** Who the last Clever sign-in signed in to EducateOS. */
  signedInAs?: PersonaId;
  /** Whether that sign-in's id_token and district checks passed, as its hops recorded them. */
  identityChecked?: boolean;
  /** What the first complete sync brought in. */
  firstSync?: { people: number; classes: number; schools: number; enrollments: number };
  /** What the last delta sync changed in the directory's people. */
  delta?: Changed;
  /** The gradebook the last delivered grade landed in. */
  landedIn?: GradeRouteKind;
}

/** One step of the tour. */
export interface TourStep {
  id: TourStepId;
  /** What to do, as an instruction; the one line presenter mode keeps. */
  title: string;
  /** One or two plain sentences on what is going on, from what the tour has seen so far. */
  explain: (facts: TourFacts) => string;
  /** The label of the step's "Show me", which takes the visitor to where it is done. */
  showMe: string;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The tour's steps, in order. */
export const CLEVER_TOUR_STEPS: readonly TourStep[] = [
  {
    id: "portal",
    title: "Sign in to the district portal as Elaine Park and open EducateOS",
    explain: () => "Cedar Valley's people open EducateOS from their district portal, which signs them in with Clever Instant Login. The portal and Clever are simulated in your browser; “Under the hood” shows every step of the sign-in.",
    showMe: "Open the portal as Elaine Park",
  },
  {
    id: "sign-in",
    title: "Clever sends you to Cedar Valley and EducateOS checks your Clever identity",
    explain: (facts) => facts.identityChecked === true
      ? "EducateOS exchanged the launch's code for a signed id_token, verified it, and matched it to Cedar Valley's Clever district before it started a session."
      : "EducateOS exchanges the launch's code for a signed id_token, verifies its signature and nonce, and checks it comes from Cedar Valley's Clever district before it starts a session.",
    showMe: "Open the portal as Elaine Park",
  },
  {
    id: "first-sync",
    title: "Run a complete Clever sync from Roster sync",
    explain: ({ firstSync }) => firstSync === undefined
      ? "Cedar Valley starts empty. A complete sync reads its whole roster from Clever's Data API, here a simulated one, and applies it."
      : `The complete sync brought in ${count(firstSync.people, "person", "people")}, ${count(firstSync.classes, "class", "classes")}, ${count(firstSync.schools, "school")} and ${count(firstSync.enrollments, "enrollment")}.`,
    showMe: "Open Roster sync",
  },
  {
    id: "clever-change",
    title: "Withdraw a student or add one in Clever",
    explain: () => "The Clever side changes the roster in the simulated Clever, as a district's student information system would. Cedar Valley doesn't see the change until its next sync.",
    showMe: "Open the Clever side",
  },
  {
    id: "delta-sync",
    title: "Run a delta sync to bring the change in",
    explain: ({ delta }) => delta === undefined
      ? "A delta sync reads only the changes Clever has recorded since the last sync."
      : `The delta sync changed only what Clever had recorded: people ${delta.added} added, ${delta.updated} updated, ${delta.deactivated} deactivated.`,
    showMe: "Open Roster sync",
  },
  {
    id: "teacher-grade",
    title: "Switch to Dana Whitaker through the portal, grade An Nguyen's “Where does the rain go?” and release it",
    explain: () => "Dana's grade becomes an official grade of the class. EducateOS passes back only grades a teacher has approved.",
    showMe: "Open Dana Whitaker's Earth Science 8",
  },
  {
    id: "grade-out",
    title: "See where the grade landed: Google Classroom, or switch the class to Clever LMS Connect and grade again",
    explain: ({ landedIn }) => [
      landedIn === undefined ? "“Where grades land” shows what the simulated gradebook holds once a grade is sent." : `The grade landed in the simulated ${landedIn === "google-classroom" ? "Google Classroom" : "Clever LMS Connect"}, read back from it.`,
      "LMS Connect here is built to Clever's published v3.1 API and not tested against Clever. “Try sending an unapproved grade” shows the gate refusing a grade no teacher approved.",
    ].join(" "),
    showMe: "Open Where grades land as Dana Whitaker",
  },
];

/** Where the tour stands. */
export interface TourSnapshot {
  done: ReadonlySet<TourStepId>;
  facts: TourFacts;
  /** The first step not done yet, or undefined once the tour is finished. */
  current: TourStep | undefined;
}

const TEACHER_GRADE = journeyStep("teacher", "teacher.grade").done;

/**
 * The tour's progress through one booted Cedar Valley, fed by the demo's hooks into the portal,
 * the roster, the Clever side, the teacher's app and the passback gate. A store for
 * `useSyncExternalStore`; a reset makes a new one.
 */
export class CleverTourStore {
  readonly #listeners = new Set<() => void>();
  #snapshot: TourSnapshot = { done: new Set(), facts: {}, current: CLEVER_TOUR_STEPS[0] };

  /** Subscribes to every change of {@link getSnapshot}. Returns the unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The tour now; the same object until something changes. */
  getSnapshot = (): TourSnapshot => this.#snapshot;

  /** The portal's EducateOS tile was clicked while signed in to the portal as `persona`. */
  tileClicked(persona: PersonaId): void {
    if (persona === "admin") this.#update(["portal"]);
  }

  /** A hop of an Instant Login ran. */
  hop(hop: InstantLoginHop): void {
    if (hop.id === "id-token" || hop.id === "district-match") {
      const passedSoFar = this.#snapshot.facts.identityChecked ?? true;
      this.#update([], { identityChecked: hop.id === "id-token" ? hop.ok : passedSoFar && hop.ok });
    }
  }

  /** Instant Login signed `persona` in to the district. */
  signedIn(persona: PersonaId): void {
    this.#update(["sign-in"], { signedInAs: persona });
  }

  /** A roster sync ran, however it was run. */
  synced(result: RosterSyncResult): void {
    const run = result.run;
    if (run?.outcome !== "succeeded") return;
    const { done } = this.#snapshot;
    if (run.mode === "complete" && !done.has("first-sync")) {
      const { principals, offerings, schools, enrollments } = run.counts;
      this.#update(["first-sync"], { firstSync: { people: principals.added, classes: offerings.added, schools: schools.added, enrollments: enrollments.added } });
    } else if (run.mode === "delta" && done.has("clever-change")) {
      const { added, updated, deactivated } = run.counts.principals;
      this.#update(["delta-sync"], { delta: { added, updated, deactivated } });
    }
  }

  /** The visitor changed the district in Clever. */
  cleverChanged(_change: PendingChange): void {
    this.#update(["clever-change"]);
  }

  /** `persona`'s app made `request`, which the district answered with `status`. */
  responded(persona: PersonaId, request: Pick<Request, "method" | "url">, status: number): void {
    if (persona === "teacher" && requestDoes(TEACHER_GRADE, request, status)) this.#update(["teacher-grade"]);
  }

  /** The passback gate sent or refused a grade. Only a grade it sent finishes the tour. */
  graded(event: GradeEvent): void {
    if (event.outcome !== "refused") this.#update(["grade-out"], { landedIn: event.landed.via });
  }

  #update(steps: readonly TourStepId[], facts: Partial<TourFacts> = {}): void {
    const done = new Set([...this.#snapshot.done, ...steps]);
    this.#snapshot = { done, facts: { ...this.#snapshot.facts, ...facts }, current: CLEVER_TOUR_STEPS.find((step) => !done.has(step.id)) };
    for (const listener of this.#listeners) listener();
  }
}

/** The places the tour can take the visitor, and the setup a jump can run first. */
export interface TourActions {
  /**
   * Opens the portal signed in as `persona`. With `launch`, it then opens EducateOS from the tile,
   * running the same Instant Login a click does, and their app opens at `route` if given.
   */
  openPortalAs(persona: PersonaId, options?: { launch?: boolean; route?: string }): void;
  /** Opens the admin console's Roster sync screen as Elaine Park, through the portal if she isn't signed in. */
  openRosterSync(options?: { launch?: boolean }): void;
  /** Opens the Clever side panel. */
  openCleverSide(): void;
  /** The teacher's Earth Science 8 submissions, as a Teacher Studio hash route, once the roster has it. */
  teacherClassRoute(): Promise<string | undefined>;
  /** Runs the district's first roster sync, as its administrator, if no sync has brought the roster in. */
  ensureFirstSync(): Promise<void>;
}

/** Takes the visitor to where `step` is done, changing nothing in the district. */
export async function showMe(step: TourStepId, actions: TourActions, launch = false): Promise<void> {
  switch (step) {
    case "portal":
    case "sign-in":
      return actions.openPortalAs("admin");
    case "first-sync":
    case "delta-sync":
      return actions.openRosterSync({ launch });
    case "clever-change":
      return actions.openCleverSide();
    case "teacher-grade":
    case "grade-out": {
      const route = await actions.teacherClassRoute();
      return actions.openPortalAs("teacher", { launch, ...(route === undefined ? {} : { route }) });
    }
  }
}

/**
 * Presenter mode's jump: runs the setup a later step needs and is safe to run for the presenter
 * (the first sync, through the same API the Roster sync screen calls), then takes them there,
 * signed in through the portal. The portal and its sign-in are left for the presenter to do.
 */
export async function jumpTo(step: TourStepId, actions: TourActions): Promise<void> {
  const index = CLEVER_TOUR_STEPS.findIndex((s) => s.id === step);
  if (index > CLEVER_TOUR_STEPS.findIndex((s) => s.id === "first-sync")) await actions.ensureFirstSync();
  await showMe(step, actions, index > 1);
}
