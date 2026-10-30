import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AdminApiError, type AdminClient } from "./client.ts";

const ClientContext = createContext<AdminClient | undefined>(undefined);

/** Provides the admin client to every screen. */
export const AdminClientProvider = ({ client, children }: { client: AdminClient; children: ReactNode }) => (
  <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
);

/** The admin client. */
export const useClient = (): AdminClient => {
  const client = useContext(ClientContext);
  if (client === undefined) throw new Error("useClient needs an AdminClientProvider");
  return client;
};

/** Where a load stands. */
export type Loaded<T> =
  | { status: "loading" }
  | { status: "error"; message: string; code?: string }
  | { status: "ready"; data: T };

/**
 * Loads whenever `key` changes, ignoring answers to superseded loads. A `reload` keeps the previous
 * answer on screen while it runs.
 */
export const useLoad = <T,>(key: string, load: (client: AdminClient) => Promise<T>): Loaded<T> & { reload: () => void } => {
  const client = useClient();
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<{ key: string; loaded: Loaded<T> }>({ key: "", loaded: { status: "loading" } });
  useEffect(() => {
    let live = true;
    load(client).then(
      (data) => { if (live) setState({ key, loaded: { status: "ready", data } }); },
      (error: unknown) => {
        if (!live) return;
        const message = error instanceof Error ? error.message : "Something went wrong.";
        setState({ key, loaded: { status: "error", message, ...(error instanceof AdminApiError ? { code: error.code } : {}) } });
      },
    );
    return () => { live = false; };
    // `load` is keyed by `key` and `generation` rather than listed: callers pass a fresh closure.
  }, [client, key, generation]);
  const loaded: Loaded<T> = state.key === key ? state.loaded : { status: "loading" };
  return { ...loaded, reload: () => setGeneration((g) => g + 1) };
};
