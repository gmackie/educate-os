// Teacher Studio's entry point. Real sign-in arrives with the kernel seam; until then a dev sign-in
// link carries a harness token as `?token=`, which is kept for the tab's session and removed from
// the address bar so it is not bookmarked or shared.
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { createDistrictApiClient } from "@educateos/api-client";
import { ThemeProvider } from "@gadgets/ui/theme";
import { educateosThemeMode, useSchoolManifest } from "@educateos/shell";
import { App } from "./App.tsx";
import { DistrictApiProvider } from "./DistrictApi.tsx";
import "./styles.css";

const TOKEN_KEY = "educateos.teacher.token";

const url = new URL(window.location.href);
const fromLink = url.searchParams.get("token");
if (fromLink !== null) {
  sessionStorage.setItem(TOKEN_KEY, fromLink);
  url.searchParams.delete("token");
  history.replaceState(null, "", url);
}
const token = sessionStorage.getItem(TOKEN_KEY) ?? undefined;

const client = createDistrictApiClient({ baseUrl: window.location.origin, ...(token === undefined ? {} : { token }) });

/**
 * Teacher Studio on its district's own origin (/teach/): framed in the shared SchoolShell and
 * branded from the school's manifest, which arrives after the first paint (SCHO-260).
 */
const OnTheDistrictOrigin = () => {
  const { manifest } = useSchoolManifest();
  const shell = useMemo(() => ({ school: manifest }), [manifest]);
  return <App shell={shell} />;
};

// The theme starts from, and remembers, this browser's choice, under the one key every surface on
// the district origin shares (@educateos/shell). A host that sets the theme itself (the Workshop,
// once the app is embedded there) would hand the provider its own source instead.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider source={educateosThemeMode()}>
      <DistrictApiProvider client={client}>
        <OnTheDistrictOrigin />
      </DistrictApiProvider>
    </ThemeProvider>
  </StrictMode>,
);
