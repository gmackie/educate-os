import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Empty } from "@cloudflare/kumo";
import { createDistrictApiClient } from "@educateos/api-client";
import { ThemeProvider } from "@gadgets/ui/theme";
import { educateosThemeMode } from "@educateos/shell";
import { StudentApp } from "./App.tsx";
import { behindAccess, takeSignIn } from "./signIn.ts";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
// Behind Cloudflare Access (a `VITE_CF_ACCESS_MODE=true` build), Access signs every same-origin
// request itself, so there is no token to take. Otherwise a development sign-in link carries one.
const accessMode = behindAccess();
const token = accessMode ? undefined : takeSignIn(window.location, window.history);

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
        <StudentApp
          client={createDistrictApiClient({ baseUrl: window.location.origin, ...(token === undefined ? {} : { token }) })}
          features={{ aiHelp: import.meta.env.VITE_EDUCATEOS_AI_HELP === "true" }}
        />
      )}
    </ThemeProvider>
  </StrictMode>,
);
