import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Empty } from "@cloudflare/kumo";
import { createDistrictApiClient } from "@schoolos/api-client";
import { StudentApp } from "./App.tsx";
import { takeSignIn } from "./signIn.ts";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
// Behind Cloudflare Access (a `VITE_CF_ACCESS_MODE=true` build), Access signs every same-origin
// request itself, so there is no token to take. Otherwise a development sign-in link carries one.
const accessMode = import.meta.env.VITE_CF_ACCESS_MODE === "true";
const token = accessMode ? undefined : takeSignIn(window.location, window.history);

root.render(
  <StrictMode>
    {!accessMode && token === undefined ? (
      <main className="mx-auto max-w-xl p-8">
        <Empty title="Sign in to your Learning Home" description="Open the sign-in link your school gave you." />
      </main>
    ) : (
      <StudentApp
        client={createDistrictApiClient({ baseUrl: window.location.origin, ...(token === undefined ? {} : { token }) })}
        features={{ aiHelp: import.meta.env.VITE_SCHOOLOS_AI_HELP === "true" }}
      />
    )}
  </StrictMode>,
);
