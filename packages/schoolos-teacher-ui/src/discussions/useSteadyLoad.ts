import { useState } from "react";
import type { DistrictApiClient } from "@schoolos/api-client";
import { useLoad } from "../useLoad.ts";

/**
 * {@link useLoad} that keeps showing the last data it loaded for `key` while a reload is under way,
 * so a teacher's place, focus and open forms survive each moderation step instead of flashing back
 * to a loading state. `data` is undefined only before the first load for `key` completes.
 */
export const useSteadyLoad = <T>(key: string, load: (client: DistrictApiClient) => Promise<T>) => {
  const state = useLoad(key, load);
  const [last, setLast] = useState<{ key: string; data: T }>();
  const ready = state.status === "ready" ? state.data : undefined;
  if (ready !== undefined && last?.data !== ready) setLast({ key, data: ready });
  const data = ready ?? (last?.key === key ? last.data : undefined);
  return { data, error: state.status === "error" ? state.error : undefined, reload: state.reload };
};
