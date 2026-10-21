import { useState } from "react";
import { LinkProvider } from "@cloudflare/kumo";
import { RouterProvider, type RouterHistory } from "@tanstack/react-router";
import type { DistrictApiClient } from "@schoolos/api-client";
import { ApiProvider } from "./api.tsx";
import { AppContextProvider, type StudentFeatures } from "./AppContext.tsx";
import { AppLink, createStudentRouter } from "./router.tsx";

/** What the Learning Home runs against. */
export interface StudentAppProps {
  /** The district API, already carrying the student's credential. */
  client: DistrictApiClient;
  features: StudentFeatures;
  /** The navigation history. Defaults to the browser's. */
  history?: RouterHistory;
}

/** The Student Learning Home. */
export const StudentApp = ({ client, features, history }: StudentAppProps) => {
  const [router] = useState(() => createStudentRouter(history));
  return (
    <ApiProvider client={client}>
      <AppContextProvider features={features}>
        <LinkProvider component={AppLink}>
          <RouterProvider router={router} />
        </LinkProvider>
      </AppContextProvider>
    </ApiProvider>
  );
};
