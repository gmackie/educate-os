import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Empty } from "@cloudflare/kumo";
import { createDistrictApiClient, createPairingClient, type DistrictApiClientOptions } from "@educateos/api-client";
import { ThemeProvider } from "@gadgets/ui/theme";
import { educateosThemeMode, useSchoolManifest } from "@educateos/shell";
import { StudentApp } from "./App.tsx";
import { behindAccess, takeSignIn } from "./signIn.ts";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
// Behind Cloudflare Access (a `VITE_CF_ACCESS_MODE=true` build), Access signs every same-origin
// request itself, so there is no token to take. Otherwise a development sign-in link carries one.
const accessMode = behindAccess();
const token = accessMode ? undefined : takeSignIn(window.location, window.history);

const features = { aiHelp: import.meta.env.VITE_EDUCATEOS_AI_HELP === "true" };

/**
 * The Learning Home on its district's own origin: framed in the shared SchoolShell, branded from the
 * school's manifest (which arrives after the first paint, the frame taking it on as it does), and
 * able to pair phones (SCHO-260).
 */
const OnTheDistrictOrigin = ({ connection }: { connection: DistrictApiClientOptions }) => {
  const [clients] = useState(() => ({ client: createDistrictApiClient(connection), pairing: createPairingClient(connection) }));
  const { manifest } = useSchoolManifest();
  const shell = useMemo(() => ({ school: manifest }), [manifest]);
  return <StudentApp client={clients.client} pairing={clients.pairing} shell={shell} features={features} />;
};

// The theme starts from, and remembers, this browser's choice, under the one key every surface on
// the district origin shares (@educateos/shell). A host that sets the theme itself (the Workshop,
// once the app is embedded there) would hand the provider its own source instead.
root.render(
  <StrictMode>
    <ThemeProvider source={educateosThemeMode()}>
      {!accessMode && token === undefined ? (
        <main className="mx-auto max-w-xl p-8">
          <Empty title="Sign in to your Learning Home" description="Open the sign-in link your school gave you." />
        </main>
      ) : (
        <OnTheDistrictOrigin connection={{ baseUrl: window.location.origin, ...(token === undefined ? {} : { token }) }} />
      )}
    </ThemeProvider>
  </StrictMode>,
);
