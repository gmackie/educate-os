// What Teacher Studio knows about the district origin it is served on (SCHO-260): the school's
// manifest, which frames it in the shared SchoolShell and says whether the district has AI. A host
// that embeds Teacher Studio (the Workshop's School app, the public demo) passes none, keeps its own
// frame, and is offered nothing that leaves it.
import { createContext, use } from "react";
import type { SchoolManifest } from "@educateos/shell";

/** The district origin around the app. */
export interface DistrictShell {
  /** The school's manifest (`useSchoolManifest().manifest`). */
  school: SchoolManifest;
}

export const ShellContext = createContext<DistrictShell | undefined>(undefined);

/** The district shell, or undefined where a host embeds the app. */
export const useDistrictShell = (): DistrictShell | undefined => use(ShellContext);
