// Keeps the School app's place, the Workshop URL that names it, and the route of the screen showing
// it in step. The host moves the place (a sidebar entry, the back button) with `show`; the screen
// moves its own route, which is reported to the host so the Workshop URL follows.
import { createMemoryHistory, type RouterHistory } from "@tanstack/react-router";
import { memoryHashLocation, type HashLocationSource } from "@gadgets/ui/hash-location";
import { pathOf, placeOf } from "./places.ts";

/** The School app's place, in memory: the frame's own address never moves. */
export interface FrameLocation {
  /** The current School app path. */
  read(): string;
  /** Calls `onChange` after each move, until the returned function is called. */
  subscribe(onChange: () => void): () => void;
  /** Shows `path`, which the host moved to. Not reported back. */
  show(path: string): void;
  /** Moves to `path` for the app itself, such as a link to another screen, and reports it. */
  go(path: string): void;
  /** The admin console's and Teacher Studio's route. */
  readonly hash: HashLocationSource;
  /** The Learning Home's route. */
  readonly history: RouterHistory;
}

/** A location starting at `path`, which tells `report` each move the app makes itself. */
export function createFrameLocation(path: string, report: (path: string) => void): FrameLocation {
  const start = placeOf(path);
  let current = pathOf(start);
  const listeners = new Set<() => void>();
  const set = (next: string) => {
    current = next;
    for (const listener of listeners) listener();
  };

  const hash = memoryHashLocation(start.app === "admin" || start.app === "teach" ? start.hash : "#/", (moved) => {
    const place = placeOf(current);
    if (place.app !== "admin" && place.app !== "teach") return;
    set(pathOf({ app: place.app, hash: moved }));
    report(current);
  });
  const history = createMemoryHistory({ initialEntries: [start.app === "learn" ? start.path : "/"] });
  history.subscribe(() => {
    if (placeOf(current).app !== "learn") return;
    const moved = pathOf({ app: "learn", path: history.location.pathname });
    if (moved === current) return;
    set(moved);
    report(current);
  });

  const show = (next: string) => {
    const place = placeOf(next);
    set(pathOf(place));
    if (place.app === "admin" || place.app === "teach") hash.replace(place.hash);
    // Pushed after `current` moved, so the subscription above sees nothing to report.
    if (place.app === "learn" && history.location.pathname !== place.path) history.push(place.path);
  };

  return {
    read: () => current,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    show,
    go: (next) => {
      show(next);
      report(current);
    },
    hash,
    history,
  };
}
