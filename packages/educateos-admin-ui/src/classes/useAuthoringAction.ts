import { useState } from "react";
import type { DistrictApiClient } from "@educateos/api-client";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { errorMessage } from "../app/useLoad.ts";

/** What the last directory change did: a message to show beside the form it came from. */
export type AuthoringOutcome = { kind: "done"; message: string } | { kind: "refused"; message: string };

/**
 * Runs one directory change: calls the district, announces what changed and reloads the screen.
 * The outcome, what changed or why it was refused (such as a record type the roster owns), is kept
 * to show beside the form, where the administrator is looking; the form keeps what they typed.
 */
export const useAuthoringAction = (onDone: () => void) => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const [running, setRunning] = useState<string>();
  const [outcome, setOutcome] = useState<AuthoringOutcome>();

  const run = async (action: string, change: (client: DistrictApiClient) => Promise<string>): Promise<boolean> => {
    setRunning(action);
    setOutcome(undefined);
    try {
      const message = await change(client);
      announce(message);
      setOutcome({ kind: "done", message });
      onDone();
      return true;
    } catch (e) {
      setOutcome({ kind: "refused", message: errorMessage(e) });
      return false;
    } finally {
      setRunning(undefined);
    }
  };

  return { run, outcome, running: (action: string) => running === action, busy: running !== undefined };
};
