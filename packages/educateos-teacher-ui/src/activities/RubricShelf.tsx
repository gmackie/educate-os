import { createContext, use, useState, type ReactNode } from "react";
import type { RubricRelease } from "../types.ts";

interface Shelf {
  rubrics: readonly RubricRelease[];
  add: (rubric: RubricRelease) => void;
}

const RubricShelfContext = createContext<Shelf | null>(null);

/**
 * The rubrics the teacher signed in this session, so the activity being built can show the one it
 * uses before any assignment does. Reviews read a rubric back from the district instead
 * (teacher.getRubric), which answers only for rubrics a class assignment uses.
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
