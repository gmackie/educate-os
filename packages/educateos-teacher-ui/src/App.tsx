import type { ReactNode } from "react";
import { Text } from "@cloudflare/kumo";
import { ChalkboardTeacher } from "@phosphor-icons/react";
import { unlinkedSignInOf, type RouteResponse } from "@educateos/api-client";
import { SchoolShell, shellRoleOf } from "@educateos/shell";
import { ThemeModeButton } from "@gadgets/ui/theme";
import { AnnouncerProvider, useAnnounce } from "./Announcer.tsx";
import { ClassPage } from "./classes/ClassPage.tsx";
import { MyClassesPage } from "./classes/MyClassesPage.tsx";
import { NotAddedYet } from "./NotAddedYet.tsx";
import { RubricShelfProvider } from "./activities/RubricShelf.tsx";
import { routeHref, useRoute } from "./route.ts";
import { ShellContext, type DistrictShell } from "./shell.tsx";
import { useLoad, type LoadState } from "./useLoad.ts";

/** The theme control, announcing through the app's live region. */
const ThemeControl = () => {
  const announce = useAnnounce();
  return <ThemeModeButton onAnnounce={announce} />;
};

/** Teacher Studio framed by the district's shell (SCHO-260), with the signed-in person's own navigation. */
const InShell = ({ shell, me, children }: { shell: DistrictShell; me: LoadState<RouteResponse<"me.get">>; children: ReactNode }) => {
  const announce = useAnnounce();
  return (
    <SchoolShell
      school={shell.school}
      role={me.status === "ready" ? shellRoleOf(me.data) : undefined}
      user={me.status === "ready" ? { name: me.data.displayName } : undefined}
      onAnnounce={announce}
    >
      {children}
    </SchoolShell>
  );
};

export interface AppProps {
  /**
   * The district origin around Teacher Studio (SCHO-260): frames it in the shared SchoolShell. A
   * host that embeds it omits this and keeps its own frame.
   */
  shell?: DistrictShell;
}

/** Teacher Studio: the landmarks every screen shares, and the screen the URL names. */
export const App = ({ shell }: AppProps = {}) => {
  const route = useRoute();
  const me = useLoad("me", (client) => client.call("me.get"));
  const unlinked = me.status === "error" ? unlinkedSignInOf(me.error) : undefined;
  const screen = unlinked !== undefined ? <NotAddedYet signIn={unlinked} /> : route.screen === "classes" ? <MyClassesPage /> : <ClassPage route={route} />;
  if (shell !== undefined) {
    return (
      <ShellContext value={shell}>
        <AnnouncerProvider>
          <RubricShelfProvider>
            <InShell shell={shell} me={me}>{screen}</InShell>
          </RubricShelfProvider>
        </AnnouncerProvider>
      </ShellContext>
    );
  }
  return (
    <AnnouncerProvider>
      <RubricShelfProvider>
        <a href="#main" onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }} className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-kumo-base focus:p-2">
          Skip to main content
        </a>
        <header className="flex items-center justify-between gap-4 border-b border-kumo-line px-4 py-3 md:px-8">
          <a href={routeHref({ screen: "classes" })} className="flex items-center gap-2 rounded text-kumo-default no-underline focus-visible:ring-2 focus-visible:ring-kumo-brand">
            <ChalkboardTeacher size={24} aria-hidden />
            <Text variant="heading" as="span">Teacher Studio</Text>
          </a>
          <div className="flex items-center gap-3">
            <ThemeControl />
            {me.status === "ready" && <Text variant="secondary" as="span">{me.data.displayName}</Text>}
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl px-4 py-6 outline-none md:px-8">
          {screen}
        </main>
      </RubricShelfProvider>
    </AnnouncerProvider>
  );
};
