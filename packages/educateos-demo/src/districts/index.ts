// The demo's districts: what the picker says about each before it boots, and how to boot it. Each
// district is its own module; Cedar Valley's is loaded only when a visitor opens it, since it brings
// a Clever fake and its integration that Northfield's visitors never need.
import { CEDARVALLEY_PERSONAS } from "./cedarvalleyPersonas.ts";
import { bootNorthfield, NORTHFIELD_PERSONAS } from "./northfield.ts";
import type { DemoDistrict, DistrictKey, Persona } from "./shared.ts";

export type { DemoDistrict, DemoRoster, DistrictKey, Persona, PersonaId, RosterSyncResult } from "./shared.ts";

/** A district a visitor can open, as the demo describes it before it boots. */
export interface DistrictInfo {
  key: DistrictKey;
  /** Its full name, such as "Northfield Public Schools". */
  name: string;
  /** Its name in a switcher, such as "Northfield". */
  shortName: string;
  /** The systems it rosters and teaches through, such as "OneRoster + Canvas". */
  integrations: string;
  /** What the picker says about it, after the full name. */
  introduction: string;
  /** A notice the demo keeps on screen while the visitor is in this district. */
  notice?: string;
  /** Who a visitor can be, in the order the picker offers them. */
  personas: readonly Persona[];
  /** Boots a fresh copy of the district in the page. */
  boot(): Promise<DemoDistrict>;
}

/** Every district the demo offers, Northfield first: it is where a visitor lands. */
export const DISTRICTS: readonly DistrictInfo[] = [
  {
    key: "northfield",
    name: "Northfield Public Schools",
    shortName: "Northfield",
    integrations: "OneRoster + Canvas",
    introduction: "is a fictional district, with invented people and classes.",
    personas: NORTHFIELD_PERSONAS,
    boot: bootNorthfield,
  },
  {
    key: "cedarvalley",
    name: "Cedar Valley USD",
    shortName: "Cedar Valley",
    integrations: "Clever + Google Classroom",
    introduction: "is a fictional district that rosters through Clever. It starts empty: sign in as the administrator and run its first Clever sync to bring in its people and classes.",
    notice: "Simulated Clever district — runs on our Clever fakes, built to Clever's published v3.1 API. Not connected to Clever.",
    personas: CEDARVALLEY_PERSONAS,
    boot: async () => (await import("./cedarvalley.ts")).bootCedarValley(),
  },
];

/** The district called `key`. */
export const districtInfo = (key: DistrictKey): DistrictInfo => DISTRICTS.find((d) => d.key === key)!;

/** The district a page's query string opens (`?district=cedarvalley`), or Northfield. */
export function districtFromSearch(search: string): DistrictKey {
  const asked = new URLSearchParams(search).get("district");
  return DISTRICTS.find((d) => d.key === asked)?.key ?? "northfield";
}
