import { useEffect, useState } from "react";
import { DistrictApiError, type DistrictApiClient } from "@educateos/api-client";
import { useAdminClient } from "./AdminClientContext.tsx";

/** Where a load from the district stands. */
export type Loaded<T> =
  | { status: "loading" }
  | {
    status: "error";
    message: string;
    /** The failure itself, for a caller that answers some failures differently. */
    error: unknown;
  }
  | { status: "ready"; data: T };

/** A message safe to show an administrator, with the reference support can look the request up by. */
export function errorMessage(error: unknown): string {
  if (error instanceof DistrictApiError) {
    return error.correlationId === undefined ? error.message : `${error.message} (reference ${error.correlationId})`;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

/**
 * Loads from the district whenever `key` changes, ignoring answers to loads that were superseded.
 * `load` is read when the key changes, so it may close over values the key stands for. While a
 * `reload` is in flight the previous answer for the same key is kept, so the screen does not blank.
 */
export const useLoad = <T>(key: string, load: (client: DistrictApiClient) => Promise<T>): Loaded<T> & { reload: () => void } => {
  const client = useAdminClient();
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<{ key: string; for: string; loaded: Loaded<T> }>({ key: "", for: "", loaded: { status: "loading" } });
  const current = `${key}#${generation}`;

  useEffect(() => {
    let live = true;
    load(client).then(
      (data) => { if (live) setState({ key, for: current, loaded: { status: "ready", data } }); },
      (error: unknown) => { if (live) setState({ key, for: current, loaded: { status: "error", message: errorMessage(error), error } }); },
    );
    return () => { live = false; };
    // `load` is keyed by `current` rather than listed: callers pass a fresh closure every render.
  }, [client, current]);

  const loaded: Loaded<T> = state.key === key ? state.loaded : { status: "loading" };
  return { ...loaded, reload: () => setGeneration((g) => g + 1) };
};
