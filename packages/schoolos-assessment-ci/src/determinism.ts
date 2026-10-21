/** Thrown when an evaluator reaches for the clock, randomness, a timer or the network. */
export class NondeterminismError extends Error {
  constructor(what: string) {
    super(`A deterministic evaluator may not use ${what}.`);
    this.name = "NondeterminismError";
  }
}

/** Freezes `value` and everything reachable from it, returning it. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return value;
}

/** A property replaced for the duration of a guarded call, and how to put it back. */
interface Patch {
  target: object;
  key: PropertyKey;
  own: PropertyDescriptor | undefined;
}

/**
 * Runs `fn` with every ambient source of nondeterminism withdrawn: the clock (`Date.now`, `new
 * Date()`, `performance.now`), randomness (`Math.random`, `crypto.getRandomValues`,
 * `crypto.randomUUID`), timers and microtasks, and the network (`fetch`). Each throws
 * {@link NondeterminismError} instead. Everything is restored before it returns or throws.
 *
 * `fn` must be synchronous, which is also why replacing the globals is safe: no other code can run
 * on this isolate until it returns. A result that is a promise is refused, since its work would
 * escape the guard. The sticky `violated` flag reports a violation even if the evaluator caught it.
 */
export function runDeterministically<T>(fn: () => T): { result: T; violated: false } | { violated: true; error: NondeterminismError } {
  let violation: NondeterminismError | undefined;
  const record = (what: string) => () => {
    violation ??= new NondeterminismError(what);
    throw violation;
  };
  const patches: Patch[] = [];
  const replace = (target: object | undefined, key: PropertyKey, value: unknown) => {
    if (target === undefined) return;
    const own = Object.getOwnPropertyDescriptor(target, key);
    if (own !== undefined && own.configurable !== true && own.writable !== true) return;
    patches.push({ target, key, own });
    Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: own?.enumerable ?? false });
  };

  // `Date` keeps only its deterministic uses: dates built from explicit values, and parsing.
  replace(globalThis, "Date", new Proxy(globalThis.Date, {
    apply: record("the clock"),
    construct(target, args, newTarget) {
      if (args.length === 0) record("the clock")();
      return Reflect.construct(target, args, newTarget) as object;
    },
    get(target, key, receiver) {
      if (key === "now") return record("the clock");
      return Reflect.get(target, key, receiver) as unknown;
    },
  }));
  replace(Math, "random", record("randomness"));
  replace(globalThis.crypto, "getRandomValues", record("randomness"));
  replace(globalThis.crypto, "randomUUID", record("randomness"));
  replace(globalThis.performance, "now", record("the clock"));
  for (const key of ["fetch", "setTimeout", "setInterval", "setImmediate", "queueMicrotask"]) {
    replace(globalThis, key, record(key === "fetch" ? "the network" : "timers"));
  }

  try {
    const result = fn();
    if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
      violation ??= new NondeterminismError("asynchronous work");
    }
    if (violation !== undefined) return { violated: true, error: violation };
    return { result, violated: false };
  } catch (error) {
    if (violation !== undefined) return { violated: true, error: violation };
    throw error;
  } finally {
    for (const { target, key, own } of patches.toReversed()) {
      if (own === undefined) Reflect.deleteProperty(target, key);
      else Object.defineProperty(target, key, own);
    }
  }
}
