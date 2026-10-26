import { useEffect, useSyncExternalStore } from "react";
import type { DistrictApiClient } from "@educateos/api-client";
import { AdminApp } from "@educateos/admin-ui/src/App.tsx";
import { StudentApp } from "@educateos/student-ui/src/App.tsx";
import type { Embedding } from "@educateos/student-ui/src/AppContext.tsx";
import { App as TeacherApp } from "@educateos/teacher-ui/src/App.tsx";
import { DistrictApiProvider } from "@educateos/teacher-ui/src/DistrictApi.tsx";
import type { FrameLocation } from "./frameLocation.ts";
import { linkAction, placeOf, type Place } from "./places.ts";
import { SchoolHome } from "./SchoolHome.tsx";

interface SchoolAppProps {
  client: DistrictApiClient;
  location: FrameLocation;
  embedding: Embedding;
}

/** The School app: the district screen for the place the Workshop URL names. */
export const SchoolApp = ({ client, location, embedding }: SchoolAppProps) => {
  const place = placeOf(useSyncExternalStore(location.subscribe, location.read));
  useLinksStayInApp(place.app, location);
  useLearningHomeType(place.app === "learn");
  switch (place.app) {
    case "home":
      return <SchoolHome client={client} onOpen={location.go} />;
    case "admin":
      return <AdminApp client={client} />;
    case "teach":
      return (
        <DistrictApiProvider client={client}>
          <TeacherApp />
        </DistrictApiProvider>
      );
    case "learn":
      return <StudentApp client={client} features={{ aiHelp: false }} history={location.history} embedding={embedding} />;
  }
};

/**
 * Keeps every link click inside the app (see `linkAction`): a screen's hash links move its route,
 * links to another screen move to its place, and nothing navigates the frame itself.
 */
const useLinksStayInApp = (app: Place["app"], location: FrameLocation) => {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (anchor === null || anchor.hasAttribute("download")) return;
      const action = linkAction(anchor.getAttribute("href")!, app);
      if (action === undefined) return;
      event.preventDefault();
      if (action.kind === "route") location.hash.assign(action.hash);
      else if (action.kind === "place") location.go(action.path);
      else if (action.kind === "focus") document.getElementById(action.id)?.focus();
    };
    // Capture, so a hash link is handled before it can move the frame's own address.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [app, location]);
};

/** The Learning Home reads at the browser's default text sizes (styles.css), while it is showing. */
const useLearningHomeType = (learning: boolean) => {
  useEffect(() => {
    if (!learning) return;
    document.documentElement.dataset.app = "learning-home";
    return () => {
      delete document.documentElement.dataset.app;
    };
  }, [learning]);
};
