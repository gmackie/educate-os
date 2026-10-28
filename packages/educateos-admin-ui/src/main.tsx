import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { createDistrictApiClient } from "@educateos/api-client";
import { ThemeProvider } from "@gadgets/ui/theme";
import { educateosThemeMode, useSchoolManifest } from "@educateos/shell";
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

/**
 * The console on its district's own origin (/admin/): framed in the shared SchoolShell and branded
 * from the school's manifest, which arrives after the first paint (SCHO-260).
 */
const OnTheDistrictOrigin = () => {
  const { manifest } = useSchoolManifest();
  const shell = useMemo(() => ({ school: manifest }), [manifest]);
  return <AdminApp client={client} shell={shell} />;
};

// The theme starts from, and remembers, this browser's choice, under the one key every surface on
// the district origin shares (@educateos/shell). A host that sets the theme itself (the Workshop,
// once the app is embedded there) would hand the provider its own source instead.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider source={educateosThemeMode()}>
      <OnTheDistrictOrigin />
    </ThemeProvider>
  </StrictMode>,
);
