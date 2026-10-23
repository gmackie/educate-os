import { useState } from "react";
import type { DistrictApiClient } from "@schoolos/api-client";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { errorMessage } from "../app/useLoad.ts";

/**
 * Runs one directory change: calls the district, announces what changed and reloads the screen.
 * A refusal, such as a record type the roster owns, is kept as a message to show beside the form,
 * and the form keeps what the administrator typed.
 */
export const useAuthoringAction = (onDone: () => void) => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const [running, setRunning] = useState<string>();
  const [error, setError] = useState<string>();

  const run = async (action: string, change: (client: DistrictApiClient) => Promise<string>): Promise<boolean> => {
    setRunning(action);
    setError(undefined);
    try {
      announce(await change(client));
      onDone();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setRunning(undefined);
    }
  };

  return { run, error, running: (action: string) => running === action, busy: running !== undefined };
};
