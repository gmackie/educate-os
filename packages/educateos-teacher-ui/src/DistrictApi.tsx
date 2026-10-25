import { createContext, use, type ReactNode } from "react";
import type { DistrictApiClient } from "@educateos/api-client";

const DistrictApiContext = createContext<DistrictApiClient | null>(null);

/** Provides the signed-in teacher's district API client to the whole app. */
export const DistrictApiProvider = ({ client, children }: { client: DistrictApiClient; children: ReactNode }) => (
  <DistrictApiContext value={client}>{children}</DistrictApiContext>
);

/** The district API client. Every screen reads its data through it and nothing else. */
export const useDistrictApi = (): DistrictApiClient => {
  const client = use(DistrictApiContext);
  if (client === null) throw new Error("useDistrictApi needs a DistrictApiProvider");
  return client;
};
