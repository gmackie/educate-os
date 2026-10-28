import { useEffect, useRef } from "react";
import { Banner, Loader, Text } from "@cloudflare/kumo";
import { ThemeModeButton } from "@gadgets/ui/theme";
import type { Me } from "../shared/api.ts";
import { AnnouncerProvider, useAnnounce } from "./app/Announcer.tsx";
import type { AdminClient } from "./app/client.ts";
import { AdminClientProvider, useLoad } from "./app/context.tsx";
import { SCREENS, useRoute, type Route } from "./app/route.ts";
import { AuditPage } from "./screens/AuditPage.tsx";
import { DevicesPage } from "./screens/DevicesPage.tsx";
import { SettingsPage } from "./screens/SettingsPage.tsx";
import { UsersPage } from "./screens/UsersPage.tsx";
import { WorkspacePage } from "./screens/WorkspacePage.tsx";
import { WorkspacesPage } from "./screens/WorkspacesPage.tsx";

const Screen = ({ route, me }: { route: Route; me: Me }) => {
  switch (route.screen) {
    case "workspaces": return <WorkspacesPage me={me} />;
    case "workspace": return <WorkspacePage key={route.id} id={route.id} tab={route.tab} me={me} />;
    case "users": return <UsersPage me={me} />;
    case "devices": return <DevicesPage me={me} />;
    case "audit": return <AuditPage />;
    case "settings": return <SettingsPage me={me} />;
  }
};

const Console = () => {
  const route = useRoute();
  const me = useLoad("me", (client) => client.get<Me>("/api/me"));
  const announce = useAnnounce();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  const section = route.screen === "workspace" ? "workspaces" : route.screen;

  // Moving between screens moves focus to the new one, as a page load would.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus();
  }, [route]);

  return (
    <div className="min-h-screen bg-kumo-base text-kumo-default">
      <a href="#main" onClick={(event) => { event.preventDefault(); main.current?.focus(); }} className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:bg-kumo-base focus:p-2">
        Skip to content
      </a>
      <header className="flex items-center justify-between gap-4 border-b border-kumo-line px-4 py-3">
        <Text as="h1" variant="heading" size="lg">EducateOS Admin</Text>
        <div className="flex items-center gap-3">
          {me.status === "ready" && <span className="text-kumo-subtle">{me.data.operator.email}</span>}
          <ThemeModeButton onAnnounce={announce} />
        </div>
      </header>
      {me.status !== "ready" ? (
        <main id="main" ref={main} tabIndex={-1} className="mx-auto max-w-7xl p-4 outline-none md:p-6">
          {me.status === "loading"
            ? <div className="flex items-center gap-2" role="status"><Loader size="sm" /><Text>Checking your access...</Text></div>
            : <Banner variant="error" title="You can't use this admin" description={me.message} />}
        </main>
      ) : (
        <div className="mx-auto flex max-w-7xl flex-col md:flex-row">
          <nav aria-label="Admin sections" className="border-b border-kumo-line p-2 md:w-56 md:shrink-0 md:border-b-0 md:border-r">
            <ul className="flex gap-1 overflow-x-auto md:flex-col">
              {SCREENS.map((screen) => (
                <li key={screen.path} className="shrink-0">
                  <a
                    href={`#/${screen.path}`}
                    aria-current={screen.path === section ? "page" : undefined}
                    className="block rounded-md px-3 py-2 text-kumo-default hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-kumo-focus aria-[current=page]:bg-kumo-tint aria-[current=page]:font-semibold"
                  >
                    {screen.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <main id="main" ref={main} tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none md:p-6">
            <Screen route={route} me={me.data} />
          </main>
        </div>
      )}
    </div>
  );
};

/** The EducateOS admin, reading from `client`. */
export const AdminApp = ({ client }: { client: AdminClient }) => (
  <AdminClientProvider client={client}>
    <AnnouncerProvider>
      <Console />
    </AnnouncerProvider>
  </AdminClientProvider>
);
