// The evaluator registry. The lookup-by-name pattern is adapted from PlayTrek's Hall Monitor,
// `packages/ai/src/hallMonitor/evaluators/registry.ts` at commit 7258e4347, which mapped a name to
// one evaluator function. Here a name has any number of immutable releases, and the registry pins
// which release new runs use, so upgrading an evaluator is an explicit, recorded change.
import { SchoolOsError } from "@schoolos/contracts";
import { EvaluatorId, SemVer, evaluatorLabel, type Evaluator, type EvaluatorRelease } from "./sdk.ts";

/**
 * Every evaluator release a district can run, and the release of each evaluator new runs are
 * pinned to. Immutable: a release is registered once, and changing a pin makes a new registry.
 *
 * A run records the exact releases it resolved when it was queued, and executes those
 * ({@link get}), so moving a pin never changes a queued or finished run; it gives new runs a new
 * `evaluatorRelease` and so a new run key.
 */
export class EvaluatorRegistry {
  readonly #releases: ReadonlyMap<string, Evaluator>;
  readonly #pins: ReadonlyMap<EvaluatorId, SemVer>;

  /**
   * @param evaluators Every release available. One ID and release may appear only once.
   * @param pins The release of each evaluator new runs use. Every pin names a registered release.
   */
  constructor(evaluators: readonly Evaluator[], pins: Readonly<Record<string, string>>) {
    const releases = new Map<string, Evaluator>();
    for (const evaluator of evaluators) {
      const label = evaluatorLabel(evaluator);
      if (releases.has(label)) throw new Error(`evaluator ${label} is registered twice`);
      releases.set(label, evaluator);
    }
    const pinned = new Map<EvaluatorId, SemVer>();
    for (const [rawId, rawRelease] of Object.entries(pins)) {
      const id = EvaluatorId.parse(rawId);
      const release = SemVer.parse(rawRelease);
      if (!releases.has(evaluatorLabel({ id, release }))) throw new Error(`pin ${id}@${release} names no registered release`);
      pinned.set(id, release);
    }
    this.#releases = releases;
    this.#pins = pinned;
  }

  /** The release new runs of `id` use. Answers `validation-failed` for an evaluator with no pin. */
  pinned(id: EvaluatorId): Evaluator {
    const release = this.#pins.get(id);
    if (release === undefined) throw new SchoolOsError("validation-failed", `No release of evaluator ${id} is available.`);
    return this.get({ id, release });
  }

  /** One exact release, as a queued run recorded it. Answers `unavailable` if it is no longer registered. */
  get(release: EvaluatorRelease): Evaluator {
    const evaluator = this.#releases.get(evaluatorLabel(release));
    if (evaluator === undefined) throw new SchoolOsError("unavailable", `Evaluator ${evaluatorLabel(release)} is not available.`);
    return evaluator;
  }

  /** A registry with the same releases and `id` pinned to `release`. */
  withPin(id: EvaluatorId, release: SemVer): EvaluatorRegistry {
    return new EvaluatorRegistry([...this.#releases.values()], { ...Object.fromEntries(this.#pins), [id]: release });
  }
}
