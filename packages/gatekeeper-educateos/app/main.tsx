// The School app's frame (SCHO-218). It runs at an opaque origin with no network: the district's
// screens reach the district through the account's capability on the host's RPC session, and the
// Workshop keeps the theme and the URL, which this frame follows and reports to.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import { createDistrictApiClient } from "@educateos/api-client";
import { installHashLocation } from "@gadgets/ui/hash-location";
import { ThemeProvider, type ThemeModeSource } from "@gadgets/ui/theme";
import { applyAccentColor, type GatekeeperAppTheme, type GatekeeperAppThemeReceiver } from "@gadgets/workshop-shared/theme";
import type { SchoolAppApi } from "../src/school-app-api.ts";
import { DISTRICT_BASE_URL, districtFetch } from "./districtFetch.ts";
import { createFrameLocation, type FrameLocation } from "./frameLocation.ts";
import { SchoolApp } from "./SchoolApp.tsx";
import "./styles.css";

// The host's side of the session, narrowed to what this app calls. Its declarations in
// @gadgets/workshop-shared/gatekeeper import Workers types, which this DOM-only build cannot resolve.
interface Host extends RpcTarget {
  readonly ui: RpcStub<SchoolAppApi>;
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  subscribeLocation(receiver: SchoolFrame): Promise<string>;
  setLocation(path: string, options?: { replace?: boolean }): Promise<void>;
}

// The theme the host has in force, seeded from the pre-paint guess in index.html.
let mode: "light" | "dark" = document.documentElement.getAttribute("data-mode") === "dark" ? "dark" : "light";
const themeListeners = new Set<() => void>();
const hostTheme: ThemeModeSource = {
  read: () => mode,
  subscribe: (onChange) => {
    themeListeners.add(onChange);
    return () => themeListeners.delete(onChange);
  },
};
const applyTheme = (theme: GatekeeperAppTheme) => {
  applyAccentColor(document.documentElement.style, theme.accentColor);
  if (theme.mode === mode) return;
  mode = theme.mode;
  for (const listener of themeListeners) listener();
};

/** What the host calls back on: theme changes, and moves of the Workshop URL. */
class SchoolFrame extends RpcTarget implements GatekeeperAppThemeReceiver {
  location: FrameLocation | undefined;

  setTheme(theme: GatekeeperAppTheme): void {
    applyTheme(theme);
  }

  setPath(path: string): void {
    this.location?.show(path);
  }
}

const main = async () => {
  const { port1, port2 } = new MessageChannel();
  // An opaque-origin frame can't name its parent's origin. The parent accepts this handshake only
  // from this frame and the null origin, and the message carries nothing but a private port.
  window.parent.postMessage({ type: "handshake" }, "*", [port2]);
  const frame = new SchoolFrame();
  const host = newMessagePortRpcSession<Host>(port1, frame);
  host.subscribeTheme(frame).then(applyTheme).catch(() => {});

  const [path, districtOrigin] = await Promise.all([host.subscribeLocation(frame).catch(() => "/"), host.ui.districtOrigin()]);
  const location = createFrameLocation(path, (moved) => {
    host.setLocation(moved).catch(() => {});
  });
  frame.location = location;
  installHashLocation(location.hash);

  const client = createDistrictApiClient({
    baseUrl: DISTRICT_BASE_URL,
    fetch: districtFetch({ request: (method, apiPath, body) => host.ui.request(method, apiPath, body) }),
  });
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider source={hostTheme}>
        {/* A deployment that does not say where its district is gets links at a placeholder; production sets it. */}
        <SchoolApp client={client} location={location} embedding={{ districtOrigin: districtOrigin ?? DISTRICT_BASE_URL }} />
      </ThemeProvider>
    </StrictMode>,
  );
};

void main();
