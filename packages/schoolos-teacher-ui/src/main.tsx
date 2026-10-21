// Teacher Studio's entry point. Real sign-in arrives with the kernel seam; until then a dev sign-in
// link carries a harness token as `?token=`, which is kept for the tab's session and removed from
// the address bar so it is not bookmarked or shared.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createDistrictApiClient } from "@schoolos/api-client";
import { App } from "./App.tsx";
import { DistrictApiProvider } from "./DistrictApi.tsx";
import "./styles.css";

const TOKEN_KEY = "schoolos.teacher.token";

const url = new URL(window.location.href);
const fromLink = url.searchParams.get("token");
if (fromLink !== null) {
  sessionStorage.setItem(TOKEN_KEY, fromLink);
  url.searchParams.delete("token");
  history.replaceState(null, "", url);
}
const token = sessionStorage.getItem(TOKEN_KEY) ?? undefined;

const client = createDistrictApiClient({ baseUrl: window.location.origin, ...(token === undefined ? {} : { token }) });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DistrictApiProvider client={client}>
      <App />
    </DistrictApiProvider>
  </StrictMode>,
);
