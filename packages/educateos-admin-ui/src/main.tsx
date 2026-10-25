import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createDistrictApiClient } from "@educateos/api-client";
import { ThemeProvider, storedThemeMode } from "@gadgets/ui/theme";
import { AdminApp } from "./App.tsx";
import "./styles.css";

// Development sign-in: `?token=` takes a token the harness prints and keeps it for this tab only,
// then drops it from the address bar so it is not bookmarked or shared. Real sign-in comes from
// the platform, which attaches the credential itself.
const TOKEN_KEY = "educateos-admin-token";
const url = new URL(window.location.href);
const fromUrl = url.searchParams.get("token");
if (fromUrl !== null) {
  sessionStorage.setItem(TOKEN_KEY, fromUrl);
  url.searchParams.delete("token");
  window.history.replaceState(null, "", url);
}
const token = sessionStorage.getItem(TOKEN_KEY) ?? undefined;

const client = createDistrictApiClient({ baseUrl: window.location.origin, ...(token === undefined ? {} : { token }) });

// The theme starts from, and remembers, this browser's choice. A host that sets the theme itself
// (the Workshop, once the app is embedded there) would hand the provider its own source instead.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider source={storedThemeMode("educateos:theme-mode")}>
      <AdminApp client={client} />
    </ThemeProvider>
  </StrictMode>,
);
