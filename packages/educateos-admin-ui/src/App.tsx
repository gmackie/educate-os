import { useEffect, useRef, type ReactNode } from "react";
import { Loader, Text } from "@cloudflare/kumo";
import { DistrictApiError, unlinkedSignInOf, type DistrictApiClient } from "@educateos/api-client";
import { AdminClientProvider } from "./app/AdminClientContext.tsx";
import { AnnouncerProvider } from "./app/Announcer.tsx";
import { NotAddedYet } from "./app/NotAddedYet.tsx";
import { NotAnAdministrator } from "./app/NotAnAdministrator.tsx";
import { SCREENS, useHashRoute, type ScreenPath } from "./app/useHashRoute.ts";
import { useDistrictConfig, type DistrictConfigState } from "./app/useDistrictConfig.ts";
import { AiBudgetsPage } from "./budgets/AiBudgetsPage.tsx";
import { ClassesAndPeoplePage } from "./classes/ClassesAndPeoplePage.tsx";
import { ClassesPage } from "./classes/ClassesPage.tsx";
import { Dashboard } from "./dashboard/Dashboard.tsx";
import { GuardiansPage } from "./guardians/GuardiansPage.tsx";
import { ModulesPage } from "./modules/ModulesPage.tsx";
import { PoliciesPage } from "./policies/PoliciesPage.tsx";
import { TermRolloverPage } from "./rollover/TermRolloverPage.tsx";
import { RosterPage } from "./roster/RosterPage.tsx";
import { LearningStandardsPage } from "./standards/LearningStandardsPage.tsx";
import { AiUsagePage } from "./usage/AiUsagePage.tsx";

const Screen = ({ path, config }: { path: ScreenPath; config: DistrictConfigState }) => {
  switch (path) {
    case "dashboard": return <Dashboard state={config} />;
    case "roster": return <RosterPage />;
    case "classes": return <ClassesPage />;
    case "classes-people": return <ClassesAndPeoplePage />;
    case "guardians": return <GuardiansPage />;
    case "modules": return <ModulesPage state={config} />;
    case "learning-standards": return <LearningStandardsPage />;
    case "policies": return <PoliciesPage state={config} />;
    case "ai-usage": return <AiUsagePage state={config} />;
    case "ai-budgets": return <AiBudgetsPage />;
    case "term-rollover": return <TermRolloverPage />;
  }
};

/**
 * What stands in for the console while the caller's access is unknown or missing, or undefined
 * once it is the console's to show. The configuration every screen shares is an administrator's
 * read, so its answer says who the caller is: someone signed in whom the school has not added, a
 * person who is not an administrator, or an administrator. Any other failure leaves the console up,
 * where each screen reports what it could not load.
 */
const accessGate = ({ config }: DistrictConfigState): ReactNode | undefined => {
  if (config.status === "loading") {
    return <div className="flex items-center gap-2" role="status"><Loader size="sm" /><Text>Checking your access...</Text></div>;
  }
  if (config.status === "ready") return undefined;
  const unlinked = unlinkedSignInOf(config.error);
  if (unlinked !== undefined) return <NotAddedYet signIn={unlinked} />;
  if (config.error instanceof DistrictApiError && config.error.code === "forbidden") return <NotAnAdministrator />;
  return undefined;
};

const Console = () => {
  const path = useHashRoute();
  const config = useDistrictConfig();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  const gate = accessGate(config);

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
        <Text as="h1" variant="heading" size="lg">EducateOS district admin</Text>
      </header>
      {gate !== undefined ? (
        <main id="main" ref={main} tabIndex={-1} className="mx-auto max-w-7xl p-4 outline-none md:p-6">
          {gate}
        </main>
      ) : (
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
            <Screen path={path} config={config} />
          </main>
        </div>
      )}
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
