import { useEffect, useState } from "react";
import type { DistrictApiClient } from "@educateos/api-client";
import { useDistrictApi } from "./DistrictApi.tsx";

/** Where a load stands. */
export type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; data: T };

/**
 * Loads data from the district API whenever `key` changes, and again on `reload()`. A response
 * that arrives after the key moved on is dropped, so a slow answer for one class never shows on
 * another's page.
 */
export const useLoad = <T>(key: string, load: (client: DistrictApiClient) => Promise<T>): LoadState<T> & { reload: () => void } => {
  const client = useDistrictApi();
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<{ for: string; value: LoadState<T> }>({ for: "", value: { status: "loading" } });
  const current = `${key}#${generation}`;

  useEffect(() => {
    let live = true;
    load(client).then(
      (data) => live && setState({ for: current, value: { status: "ready", data } }),
      (error: unknown) => live && setState({ for: current, value: { status: "error", error } }),
    );
    return () => {
      live = false;
    };
    // `load` is a fresh closure every render; `current` is what identifies the request.
  }, [client, current]);

  const value: LoadState<T> = state.for === current ? state.value : { status: "loading" };
  return { ...value, reload: () => setGeneration((n) => n + 1) };
};
