import { createContext, useContext, type ReactNode } from "react";
import type { DistrictApiClient, DistrictFileClient } from "@educateos/api-client";

/**
 * The client the console reads from. One made by `createDistrictApiClient` also streams files
 * (SCHO-367); a screen that downloads one shows only where the client can.
 */
export type AdminClient = DistrictApiClient & Partial<DistrictFileClient>;

const AdminClientContext = createContext<AdminClient | undefined>(undefined);

/** Provides the district API client every screen reads from. */
export const AdminClientProvider = ({ client, children }: { client: AdminClient; children: ReactNode }) => (
  <AdminClientContext.Provider value={client}>{children}</AdminClientContext.Provider>
);

/** The district API client. */
export const useAdminClient = (): AdminClient => {
  const client = useContext(AdminClientContext);
  if (client === undefined) throw new Error("useAdminClient needs an AdminClientProvider");
  return client;
};
