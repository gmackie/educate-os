// Registers a criterion's checks as Vitest tests, from the criteria registry. A test check needs a
// body here and a todo check must not have one, so the registry and the tests cannot drift.
import { describe, it, type TestContext } from "vitest";
import { checkTestName, criterionById, criterionTitle } from "../src/criteria.ts";

/** The body of one check's test. */
export type CheckBody = (context: TestContext) => Promise<void>;

/**
 * Registers the criterion `id`: one `describe` named after its roadmap row, one test per `test`
 * check (from `bodies`, by check ID) and one `it.todo` per todo check, named with its blockers.
 * Throws at collection if a test check has no body, a todo check has one, or a body names no check.
 */
export function criterion(id: string, bodies: Readonly<Record<string, CheckBody>>): void {
  const registered = criterionById(id);
  for (const key of Object.keys(bodies)) {
    if (!registered.checks.some((check) => check.id === key)) throw new Error(`${id} has no check ${key}`);
  }
  describe(criterionTitle(registered), () => {
    for (const check of registered.checks) {
      const body = bodies[check.id];
      if (check.status === "todo") {
        if (body !== undefined) throw new Error(`${id}/${check.id} is registered as a todo but has a test body`);
        it.todo(checkTestName(check));
      } else {
        if (body === undefined) throw new Error(`${id}/${check.id} is registered as a test but has no body`);
        it(checkTestName(check), body);
      }
    }
  });
}
