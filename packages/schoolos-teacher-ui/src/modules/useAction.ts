import { useState } from "react";
import type { DistrictApiClient } from "@schoolos/api-client";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";

/** Where a module action stands: idle, running (by name), or failed with the error to show. */
export type ActionState = { status: "idle" } | { status: "running"; action: string } | { status: "failed"; error: unknown };

/**
 * Runs one change to a class's modules at a time: calls the district, announces what changed,
 * then lets the page reload. A failure is kept to show beside the controls, and nothing the
 * teacher typed is lost.
 */
export const useAction = (onDone: () => void) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const [state, setState] = useState<ActionState>({ status: "idle" });

  const run = async (action: string, change: (client: DistrictApiClient) => Promise<string>): Promise<boolean> => {
    setState({ status: "running", action });
    try {
      announce(await change(client));
      setState({ status: "idle" });
      onDone();
      return true;
    } catch (error) {
      setState({ status: "failed", error });
      return false;
    }
  };

  return { state, run, running: (action: string) => state.status === "running" && state.action === action, busy: state.status === "running" };
};
