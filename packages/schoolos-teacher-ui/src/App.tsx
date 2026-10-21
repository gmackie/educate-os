import { Text } from "@cloudflare/kumo";
import { ChalkboardTeacher } from "@phosphor-icons/react";
import { AnnouncerProvider } from "./Announcer.tsx";
import { ClassPage } from "./classes/ClassPage.tsx";
import { MyClassesPage } from "./classes/MyClassesPage.tsx";
import { RubricShelfProvider } from "./activities/RubricShelf.tsx";
import { routeHref, useRoute } from "./route.ts";
import { useLoad } from "./useLoad.ts";

/** Teacher Studio: the landmarks every screen shares, and the screen the URL names. */
export const App = () => {
  const route = useRoute();
  const me = useLoad("me", (client) => client.call("me.get"));
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
          {me.status === "ready" && <Text variant="secondary" as="span">{me.data.displayName}</Text>}
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl px-4 py-6 outline-none md:px-8">
          {route.screen === "classes" ? <MyClassesPage /> : <ClassPage route={route} />}
        </main>
      </RubricShelfProvider>
    </AnnouncerProvider>
  );
};
