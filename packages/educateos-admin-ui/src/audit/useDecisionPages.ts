import { useState } from "react";
import type { RouteInput } from "@educateos/api-client";
import { useLoad, type Loaded } from "../app/useLoad.ts";
import type { DecisionEntry } from "./decisionLabels.ts";

type LogRoute = "admin.decisionLog" | "admin.auditLog";
type QueryOf<N extends LogRoute> = RouteInput<N> extends { query?: infer Q } ? NonNullable<Q> : never;
type Filters<N extends LogRoute> = Omit<QueryOf<N>, "before">;

/** One page of a decision log, and how to move between pages. */
export interface DecisionPages {
  loaded: Loaded<{ entries: DecisionEntry[]; nextBefore?: string }> & { reload: () => void };
  /** Which page is shown, from 1 (the newest). */
  page: number;
  /** Shows the next older page, when there is one. */
  older?: () => void;
  /** Shows the previous newer page, when this is not the first. */
  newer?: () => void;
}

/**
 * Pages back through a decision log under `filters`, newest first. The district pages by position
 * in the trail, so each older page is reached by the cursor the one before it gave; changing the
 * filters starts again from the newest.
 */
export const useDecisionPages = <N extends LogRoute>(name: N, filters: Filters<N>): DecisionPages => {
  const filterKey = JSON.stringify(filters);
  const [paging, setPaging] = useState<{ for: string; cursors: string[] }>({ for: filterKey, cursors: [] });
  const cursors = paging.for === filterKey ? paging.cursors : [];
  const before = cursors.at(-1);
  const query = { ...filters, ...(before === undefined ? {} : { before }) };
  const loaded = useLoad(`${name}:${filterKey}:${before ?? ""}`, (client) =>
    (client.call as (route: LogRoute, input: { query: typeof query }) => Promise<{ entries: DecisionEntry[]; nextBefore?: string }>)(name, { query }));
  const next = loaded.status === "ready" ? loaded.data.nextBefore : undefined;
  return {
    loaded,
    page: cursors.length + 1,
    ...(next === undefined ? {} : { older: () => setPaging({ for: filterKey, cursors: [...cursors, next] }) }),
    ...(cursors.length === 0 ? {} : { newer: () => setPaging({ for: filterKey, cursors: cursors.slice(0, -1) }) }),
  };
};
