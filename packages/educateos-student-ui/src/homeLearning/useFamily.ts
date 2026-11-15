import type { RouteResponse } from "@educateos/api-client";
import { useQuery, type Query } from "../api.tsx";

/** The signed-in adult's family, or none yet. */
export type FamilyView = NonNullable<RouteResponse<"family.home">["family"]>;

/** Loads the adult's family. */
export const useFamily = (): [Query<RouteResponse<"family.home">>, () => void] => useQuery("family-home", (api) => api.call("family.home"));
