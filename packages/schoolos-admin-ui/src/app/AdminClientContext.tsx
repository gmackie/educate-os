import { createContext, useContext, type ReactNode } from "react";
import type { DistrictApiClient } from "@schoolos/api-client";

const AdminClientContext = createContext<DistrictApiClient | undefined>(undefined);

/** Provides the district API client every screen reads from. */
export const AdminClientProvider = ({ client, children }: { client: DistrictApiClient; children: ReactNode }) => (
  <AdminClientContext.Provider value={client}>{children}</AdminClientContext.Provider>
);

/** The district API client. */
export const useAdminClient = (): DistrictApiClient => {
  const client = useContext(AdminClientContext);
  if (client === undefined) throw new Error("useAdminClient needs an AdminClientProvider");
  return client;
};
