import { createContext, use, useEffect, useRef, type ReactNode } from "react";
import { Loader, Text } from "@cloudflare/kumo";
import { DistrictApiError, unlinkedSignInOf, type DistrictApiClient } from "@educateos/api-client";
import { SchoolShell, navigationFor, shellRoleOf, type NavGroup, type NavIcon, type SchoolManifest, type ShellFeatures } from "@educateos/shell";
import { AdminClientProvider } from "./app/AdminClientContext.tsx";
import { ThemeModeButton } from "@gadgets/ui/theme";
import { AnnouncerProvider, useAnnounce } from "./app/Announcer.tsx";
import { NotAddedYet } from "./app/NotAddedYet.tsx";
import { NotAnAdministrator } from "./app/NotAnAdministrator.tsx";
import { SCREENS, useHashRoute, useSchoolRoute, type ScreenPath } from "./app/useHashRoute.ts";
import { useDistrictConfig, type DistrictConfigState } from "./app/useDistrictConfig.ts";
import { useLoad } from "./app/useLoad.ts";
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
import { SchoolPage } from "./schools/SchoolPage.tsx";
import { AiUsagePage } from "./usage/AiUsagePage.tsx";
import { OperationsPage } from "./operations/OperationsPage.tsx";

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
    case "operations": return <OperationsPage />;
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

/** The district origin around the console (SCHO-260). */
export interface DistrictShell {
  /** The school's manifest (`useSchoolManifest().manifest`). */
  school: SchoolManifest;
}

const ShellContext = createContext<DistrictShell | undefined>(undefined);

const SCREEN_ICONS: Record<ScreenPath, NavIcon> = {
  dashboard: "dashboard", roster: "roster", classes: "classes", "classes-people": "roster", guardians: "guardians", modules: "studio",
  "learning-standards": "grades", policies: "policies", "ai-usage": "usage", "ai-budgets": "budgets", "term-rollover": "rollover",
};

/**
 * The sidebar on the district origin: the signed-in person's own places across the origin (a
 * district administrator is staff, so Teacher Studio's), then, once their access is confirmed, every
 * screen of this console as the Admin group. The console routes by hash, so its own entries are hash
 * links that keep the page.
 */
export const consoleNavigation = (base: NavGroup[], admin: boolean): NavGroup[] => [
  ...base.filter((group) => group.id !== "admin"),
  ...(admin
    ? [{
      id: "admin",
      label: "Admin",
      items: SCREENS.map((screen) => ({
        id: `admin-${screen.path}`,
        label: screen.label,
        href: `#/${screen.path}`,
        icon: SCREEN_ICONS[screen.path],
        active: ({ hash }: { hash: string }) => {
          const at = hash.replace(/^#\/?/, "");
          return at === screen.path || (screen.path === "dashboard" && at === "");
        },
      })),
    }]
    : []),
];

const Console = () => {
  const shell = use(ShellContext);
  const path = useHashRoute();
  const schoolId = useSchoolRoute();
  const config = useDistrictConfig();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  const gate = accessGate(config);
  const announce = useAnnounce();

  // Moving between screens moves focus to the new screen, as a page load would, so keyboard and
  // screen-reader users start at its top. Not on first load, where focus belongs to the browser.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    (main.current ?? document.getElementById("main"))?.focus();
  }, [path, schoolId]);

  if (shell !== undefined) return <ShellConsole shell={shell} gate={gate} path={path} schoolId={schoolId} config={config} />;

  return (
    <div className="min-h-screen bg-kumo-base text-kumo-default">
      {/* Focuses the content directly: following `#main` would replace the screen named in the hash. */}
      <a href="#main" onClick={(event) => { event.preventDefault(); main.current?.focus(); }} className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded focus:bg-kumo-base focus:p-2">
        Skip to content
      </a>
      <header className="flex items-center justify-between gap-4 border-b border-kumo-line px-4 py-3">
        <Text as="h1" variant="heading" size="lg">EducateOS district admin</Text>
        <ThemeModeButton onAnnounce={announce} />
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
                    aria-current={schoolId === undefined && screen.path === path ? "page" : undefined}
                    className="block rounded-md px-3 py-2 text-kumo-default hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-kumo-focus aria-[current=page]:bg-kumo-tint aria-[current=page]:font-semibold"
                  >
                    {screen.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <main id="main" ref={main} tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none md:p-6">
            {schoolId === undefined ? <Screen path={path} config={config} /> : <SchoolPage key={schoolId} schoolId={schoolId} />}
          </main>
        </div>
      )}
    </div>
  );
};

/** The console framed by the district's shell (SCHO-260): its sections are the sidebar's Admin group. */
const ShellConsole = ({ shell, gate, path, schoolId, config }: { shell: DistrictShell; gate: ReactNode | undefined; path: ScreenPath; schoolId: string | undefined; config: DistrictConfigState }) => {
  const announce = useAnnounce();
  const me = useLoad("me", (client) => client.call("me.get"));
  const role = me.status === "ready" ? shellRoleOf(me.data) : undefined;
  const features: ShellFeatures = { ai: shell.school.features.ai };
  // Signed in as staff, a district administrator gets Teacher Studio's places as well as these.
  const base = role === undefined ? [] : navigationFor(role === "school-admin" ? "teacher" : role, features);
  const navigation = consoleNavigation(base, gate === undefined);
  return (
    <SchoolShell
      school={shell.school}
      role={role}
      user={me.status === "ready" ? { name: me.data.displayName } : undefined}
      features={features}
      navigation={navigation}
      onAnnounce={announce}
    >
      <div className="flex flex-col gap-4">
        <Text as="h1" variant="heading" size="lg">EducateOS district admin</Text>
        {gate ?? (schoolId === undefined ? <Screen path={path} config={config} /> : <SchoolPage key={schoolId} schoolId={schoolId} />)}
      </div>
    </SchoolShell>
  );
};

/** The district admin console, reading from `client`. */
export const AdminApp = ({ client, shell }: {
  client: DistrictApiClient;
  /**
   * The district origin around the console (SCHO-260): frames it in the shared SchoolShell. A host
   * that embeds it omits this and keeps its own frame.
   */
  shell?: DistrictShell;
}) => (
  <AdminClientProvider client={client}>
    <ShellContext value={shell}>
      <AnnouncerProvider>
        <Console />
      </AnnouncerProvider>
    </ShellContext>
  </AdminClientProvider>
);
