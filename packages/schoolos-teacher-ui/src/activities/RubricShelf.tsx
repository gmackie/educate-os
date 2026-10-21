import { createContext, use, useState, type ReactNode } from "react";
import type { RubricRelease } from "../types.ts";

interface Shelf {
  rubrics: readonly RubricRelease[];
  add: (rubric: RubricRelease) => void;
}

const RubricShelfContext = createContext<Shelf | null>(null);

/**
 * The rubrics the teacher signed in this session, so the activity that uses one and the reviews
 * scored against it can show its criteria and levels. The district API returns a rubric when it
 * is signed but has no way to read one back yet.
 */
export const RubricShelfProvider = ({ children }: { children: ReactNode }) => {
  const [rubrics, setRubrics] = useState<readonly RubricRelease[]>([]);
  const add = (rubric: RubricRelease) => setRubrics((shelf) => [...shelf.filter((r) => !(r.rubricId === rubric.rubricId && r.version === rubric.version)), rubric]);
  return <RubricShelfContext value={{ rubrics, add }}>{children}</RubricShelfContext>;
};

/** The session's signed rubrics. */
export const useRubricShelf = (): Shelf => {
  const shelf = use(RubricShelfContext);
  if (shelf === null) throw new Error("useRubricShelf needs a RubricShelfProvider");
  return shelf;
};
