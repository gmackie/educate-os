import { useState } from "react";
import { LinkProvider } from "@cloudflare/kumo";
import { RouterProvider, type RouterHistory } from "@tanstack/react-router";
import type { DistrictApiClient, PairingClient } from "@educateos/api-client";
import { ApiProvider } from "./api.tsx";
import { AppContextProvider, type Embedding, type StudentFeatures, type StudentHost } from "./AppContext.tsx";
import { AppLink, createStudentRouter } from "./router.tsx";
import { ShellProvider, type DistrictShell } from "./shell.tsx";

/** What the Learning Home runs against. */
export interface StudentAppProps {
  /** The district API, already carrying the student's credential. */
  client: DistrictApiClient;
  features: StudentFeatures;
  /** The navigation history. Defaults to the browser's. */
  history?: RouterHistory;
  /** How a host embeds the app, if one does. */
  embedding?: Embedding;
  /**
   * The district origin around the app (SCHO-260): frames every screen in the shared SchoolShell.
   * A host that embeds the app omits it and keeps its own frame.
   */
  shell?: DistrictShell;
  /** Opens pairing rooms for Connect phone. Without it, the page says phones can't be connected here. */
  pairing?: PairingClient;
  /** What a host runs in place of the district's own pieces, such as the demo's sign-out. */
  host?: StudentHost;
}

/** The Student Learning Home. */
export const StudentApp = ({ client, features, history, embedding, shell, pairing, host }: StudentAppProps) => {
  const [router] = useState(() => createStudentRouter(history));
  return (
    <ApiProvider client={client}>
      <AppContextProvider features={features} {...(embedding === undefined ? {} : { embedding })} {...(host === undefined ? {} : { host })}>
        <ShellProvider shell={shell} pairing={pairing}>
          <LinkProvider component={AppLink}>
            <RouterProvider router={router} />
          </LinkProvider>
        </ShellProvider>
      </AppContextProvider>
    </ApiProvider>
  );
};
