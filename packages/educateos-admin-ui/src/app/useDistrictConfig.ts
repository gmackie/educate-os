import { useState } from "react";
import type { RouteResponse } from "@educateos/api-client";
import type { ConfigurationRevision, PolicySettings } from "@educateos/contracts";
import { readDesired, type DesiredStateView } from "../configDocument.ts";
import { useLoad, type Loaded } from "./useLoad.ts";

/** A dry run of a configuration change, as the district plans it. */
export type ConfigurationPlan = Extract<RouteResponse<"admin.planConfig">, { ok: true }>["plan"];
/** One structural difference between two configurations. */
export type DiffEntry = ConfigurationPlan["diff"][number];

/** A configuration version: a revision, its place in the district's sequence, and what it changed. */
export interface ConfigVersion {
  /** 1 for the district's first revision. */
  number: number;
  /** The revision. */
  revision: ConfigurationRevision;
  /** Its desired state. */
  desired: DesiredStateView;
  /** What it changed from the version before, when the console applied it. */
  changes?: DiffEntry[];
}

/** The district's configuration as the console holds it. */
export interface DistrictConfig {
  /** The version in force; absent before setup. */
  head?: ConfigVersion;
  /** Every version the console knows, newest first. */
  versions: ConfigVersion[];
  /** The district policy floor in force. */
  districtPolicy: PolicySettings;
}

/** The district configuration, and how to record a version the console applied. */
export interface DistrictConfigState {
  /** The configuration. */
  config: Loaded<DistrictConfig>;
  /** Records a revision the console applied and reloads the configuration. */
  onApplied: (revision: ConfigurationRevision, changes: DiffEntry[]) => void;
}

/**
 * Loads the district configuration and keeps the versions applied in this session.
 *
 * The district API returns only the head revision and the revision count, so versions older than
 * the head at load time are not listed; a revision-history route would replace this session record.
 */
export const useDistrictConfig = (): DistrictConfigState => {
  const loaded = useLoad("config", (client) => client.call("admin.getConfig"));
  const [applied, setApplied] = useState<ConfigVersion[]>([]);

  const config: Loaded<DistrictConfig> = loaded.status !== "ready" ? loaded : (() => {
    const { head, revisions, districtPolicy } = loaded.data;
    const loadedHead = head === undefined ? undefined : { number: revisions, revision: head, desired: readDesired(head) };
    const versions = applied.length > 0 ? applied : loadedHead === undefined ? [] : [loadedHead];
    return { status: "ready", data: { ...(versions[0] === undefined ? {} : { head: versions[0] }), versions, districtPolicy } };
  })();

  const onApplied = (revision: ConfigurationRevision, changes: DiffEntry[]) => {
    if (config.status !== "ready") return;
    const { versions } = config.data;
    if (versions[0]?.revision.id === revision.id) return;
    const number = (versions[0]?.number ?? 0) + 1;
    setApplied([{ number, revision, desired: readDesired(revision), changes }, ...versions]);
    loaded.reload();
  };

  return { config, onApplied };
};
