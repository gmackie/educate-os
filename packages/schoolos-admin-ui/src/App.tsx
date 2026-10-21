import { useEffect, useRef } from "react";
import { Text } from "@cloudflare/kumo";
import type { DistrictApiClient } from "@schoolos/api-client";
import { AdminClientProvider } from "./app/AdminClientContext.tsx";
import { AnnouncerProvider } from "./app/Announcer.tsx";
import { SCREENS, useHashRoute, type ScreenPath } from "./app/useHashRoute.ts";
import { useDistrictConfig } from "./app/useDistrictConfig.ts";
import { Dashboard } from "./dashboard/Dashboard.tsx";
import { ModulesPage } from "./modules/ModulesPage.tsx";
import { PoliciesPage } from "./policies/PoliciesPage.tsx";
import { TermRolloverPage } from "./rollover/TermRolloverPage.tsx";
import { RosterPage } from "./roster/RosterPage.tsx";
import { AiUsagePage } from "./usage/AiUsagePage.tsx";

const Screen = ({ path }: { path: ScreenPath }) => {
  const config = useDistrictConfig();
  switch (path) {
    case "dashboard": return <Dashboard state={config} />;
    case "roster": return <RosterPage />;
    case "modules": return <ModulesPage state={config} />;
    case "policies": return <PoliciesPage state={config} />;
    case "ai-usage": return <AiUsagePage state={config} />;
    case "term-rollover": return <TermRolloverPage />;
  }
};

const Console = () => {
  const path = useHashRoute();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Moving between screens moves focus to the new screen, as a page load would, so keyboard and
  // screen-reader users start at its top. Not on first load, where focus belongs to the browser.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus();
  }, [path]);

  return (
    <div className="min-h-screen bg-kumo-base text-kumo-default">
      {/* Focuses the content directly: following `#main` would replace the screen named in the hash. */}
      <a href="#main" onClick={(event) => { event.preventDefault(); main.current?.focus(); }} className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:bg-kumo-base focus:p-2">
        Skip to content
      </a>
      <header className="border-b border-kumo-line px-4 py-3">
        <Text as="h1" variant="heading" size="lg">SchoolOS district admin</Text>
      </header>
      <div className="mx-auto flex max-w-7xl flex-col md:flex-row">
        <nav aria-label="Admin sections" className="border-b border-kumo-line p-2 md:w-56 md:shrink-0 md:border-b-0 md:border-r">
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {SCREENS.map((screen) => (
              <li key={screen.path} className="shrink-0">
                <a
                  href={`#/${screen.path}`}
                  aria-current={screen.path === path ? "page" : undefined}
                  className="block rounded-md px-3 py-2 text-kumo-default hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-kumo-ring aria-[current=page]:bg-kumo-tint aria-[current=page]:font-semibold"
                >
                  {screen.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" ref={main} tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none md:p-6">
          <Screen path={path} />
        </main>
      </div>
    </div>
  );
};

/** The district admin console, reading from `client`. */
export const AdminApp = ({ client }: { client: DistrictApiClient }) => (
  <AdminClientProvider client={client}>
    <AnnouncerProvider>
      <Console />
    </AnnouncerProvider>
  </AdminClientProvider>
);
