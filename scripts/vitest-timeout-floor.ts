// A floor under vitest's per-test and per-hook timeouts, for slow shared CI runners.
//
//     VITEST_TEST_TIMEOUT=60000 VITEST_HOOK_TIMEOUT=60000 pnpm test
//
// `gadgets-with-timeout` (with-timeout.ts) adds this module as an extra reporter to every `vitest`
// command it runs while either variable is set; unset, the command runs exactly as written.
//
// A floor rather than an override, so a package that already allows longer (integration-tests'
// 120 s, a teacher-ui 60 s) is never cut short. vitest's own `--testTimeout` cannot express that:
// a CLI value replaces the config's, in every project. Nor can a setup file passed on the command
// line, which replaces the config's `setupFiles` instead of joining them. A reporter is the one
// extension point the CLI adds alongside the config's own, and its `onInit` runs once every project
// is resolved and before any test file is scheduled; each worker's config is serialised from the
// project's config when its files are dispatched, so the raised values are what the tests see.
// Timeouts passed to an individual `it`/`describe`/hook are left alone: they are explicit too.

import { fileURLToPath } from "node:url";

/** Milliseconds per test, applied as a minimum to every vitest project's `testTimeout`. */
export const VITEST_TEST_TIMEOUT = "VITEST_TEST_TIMEOUT";

/** Milliseconds per hook, applied as a minimum to every vitest project's `hookTimeout`. */
export const VITEST_HOOK_TIMEOUT = "VITEST_HOOK_TIMEOUT";

/** The floors requested through the environment; an absent one leaves that timeout alone. */
export type TimeoutFloors = { testTimeout?: number; hookTimeout?: number };

/** The slice of a resolved vitest project config this module reads and raises. */
export type ProjectTimeouts = { testTimeout: number; hookTimeout: number };

/** The raw values of the two variables, as `parseTimeoutFloors` takes them. */
export type RawTimeoutFloors = { testTimeout?: string; hookTimeout?: string };

/**
 * The floors in `raw`. Throws on a value that is not a positive, finite number of milliseconds, so
 * a typo fails the run instead of silently keeping the defaults.
 */
export function parseTimeoutFloors(raw: RawTimeoutFloors): TimeoutFloors {
  return {
    testTimeout: parseMilliseconds(VITEST_TEST_TIMEOUT, raw.testTimeout),
    hookTimeout: parseMilliseconds(VITEST_HOOK_TIMEOUT, raw.hookTimeout),
  };
}

/** The floors this process's environment sets; see `parseTimeoutFloors` for what throws. */
export const timeoutFloorsFromEnv = (): TimeoutFloors => parseTimeoutFloors({
  testTimeout: process.env.VITEST_TEST_TIMEOUT,
  hookTimeout: process.env.VITEST_HOOK_TIMEOUT,
});

function parseMilliseconds(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const milliseconds = Number(value);
  if (value.trim() === "" || !Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new Error(`${name} needs a positive number of milliseconds, got ${JSON.stringify(value)}`);
  }
  return milliseconds;
}

/** Whether any floor is set, i.e. whether the reporter has anything to do. */
export const hasTimeoutFloor = (floors: TimeoutFloors): boolean =>
  floors.testTimeout !== undefined || floors.hookTimeout !== undefined;

/** Raises `config`'s timeouts to `floors` in place, never lowering one. */
export function raiseTimeouts(config: ProjectTimeouts, floors: TimeoutFloors): void {
  if (floors.testTimeout !== undefined) {
    config.testTimeout = Math.max(config.testTimeout, floors.testTimeout);
  }
  if (floors.hookTimeout !== undefined) {
    config.hookTimeout = Math.max(config.hookTimeout, floors.hookTimeout);
  }
}

const REPORTER_PATH = fileURLToPath(import.meta.url);

/**
 * `argv` with this module added as a reporter when it is a `vitest` command and a floor is set, and
 * `argv` unchanged otherwise. A command that names no reporter also gets `default`: an added
 * reporter would otherwise be vitest's only one, and the progress lines the idle watchdog relies on
 * would go with the default.
 */
export function withTimeoutFloorReporter(argv: string[], floors: TimeoutFloors): string[] {
  if (argv[0] !== "vitest" || !hasTimeoutFloor(floors)) return argv;
  const namesReporter = argv.some(arg => /^--reporters?(=|$)/.test(arg));
  return [...argv, ...(namesReporter ? [] : ["--reporter=default"]), `--reporter=${REPORTER_PATH}`];
}

/**
 * The vitest reporter. Structurally typed so this directory needs no vitest dependency; vitest
 * constructs a custom reporter's default export with `new`.
 */
export default class TimeoutFloorReporter {
  onInit(vitest: { projects: { config: ProjectTimeouts }[] }): void {
    const floors = timeoutFloorsFromEnv();
    for (const project of vitest.projects) raiseTimeouts(project.config, floors);
  }
}
