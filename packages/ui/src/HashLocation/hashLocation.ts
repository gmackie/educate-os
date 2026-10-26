// Where an app that keeps its routes in the URL hash (`#/classes/42`) reads and moves them. Standalone
// that is the browser's own hash. An app embedded in a frame whose own hash changes would add to its
// host's history (a frame's fragment navigations join the top page's), so the embedding page installs
// a source of its own before the app renders and follows the app's moves itself.

/** A place to keep an app's hash route. */
export interface HashLocationSource {
  /** The current hash, `#` included, or "" for none. */
  read(): string;
  /** Calls `onChange` after each change, until the returned function is called. */
  subscribe(onChange: () => void): () => void;
  /** Moves to `hash`. */
  assign(hash: string): void;
}

const windowHashLocation: HashLocationSource = {
  read: () => window.location.hash,
  subscribe: (onChange) => {
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  },
  assign: (hash) => {
    window.location.hash = hash;
  },
};

let source = windowHashLocation;

/** Makes `next` the hash every app on this page reads and moves. Call it before the app renders. */
export const installHashLocation = (next: HashLocationSource): void => {
  source = next;
};

/** The current hash. */
export const readHash = (): string => source.read();

/** Calls `onChange` after each change of the hash, until the returned function is called. */
export const subscribeToHash = (onChange: () => void): (() => void) => source.subscribe(onChange);

/** Moves to `hash`. */
export const assignHash = (hash: string): void => source.assign(hash);

/**
 * A hash kept in memory rather than the address bar. `onAssign` hears each move the app makes;
 * `replace` moves it for the host without being heard.
 */
export const memoryHashLocation = (initial: string, onAssign: (hash: string) => void): HashLocationSource & { replace(hash: string): void } => {
  let current = initial;
  const listeners = new Set<() => void>();
  const set = (hash: string) => {
    if (hash === current) return false;
    current = hash;
    for (const listener of listeners) listener();
    return true;
  };
  return {
    read: () => current,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    assign: (hash) => {
      if (set(hash)) onAssign(hash);
    },
    replace: (hash) => {
      set(hash);
    },
  };
};
