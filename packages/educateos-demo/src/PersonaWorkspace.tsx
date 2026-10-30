import { lazy, Suspense, useEffect, useState } from "react";
import { Button, Empty, Loader, Text } from "@cloudflare/kumo";
import { createHashHistory } from "@tanstack/react-router";
import type { DistrictApiClient } from "@educateos/api-client";
import { AdminApp } from "@educateos/admin-ui/src/App.tsx";
import { StudentApp } from "@educateos/student-ui/src/App.tsx";
import { App as TeacherApp } from "@educateos/teacher-ui/src/App.tsx";
import { DistrictApiProvider } from "@educateos/teacher-ui/src/DistrictApi.tsx";
import type { DistrictState } from "./DemoApp.tsx";
import { ROSTER_SYNC_ROUTE, type DemoDistrict, type DistrictInfo, type Persona, type PersonaId } from "./districts/index.ts";
import { stepsDoneBy } from "./journeys.ts";

// Only a district that passes grades back has the panel, so it comes in its own chunk.
const WhereItLanded = lazy(async () => ({ default: (await import("./grades/WhereItLanded.tsx")).WhereItLanded }));

interface PersonaWorkspaceProps {
  info: DistrictInfo;
  district: DistrictState;
  persona: Persona;
  /** What the persona's requests carry, when the district signed them in to a session; else their subject. */
  bearer?: string;
  /** Called with the journey steps the persona's last request completed. */
  onStepsDone: (ids: readonly string[]) => void;
  /** Sees each request the persona's app makes and the district's answer, for the Clever tour. */
  onResponse?: (request: Request, status: number) => void;
  /** Switches to another persona of the same district, opening their app at `route` if given. */
  onChoose: (persona: PersonaId, route?: string) => void;
  /** Opens the teacher's "Where grades land" panel each time it changes. */
  gradesRequest?: number;
}

/** The persona's own app, once the district is up, and its roster has brought the persona in. */
export const PersonaWorkspace = ({ info, district, persona, bearer, onStepsDone, onResponse, onChoose, gradesRequest }: PersonaWorkspaceProps) => {
  if (district.status === "booting") {
    return (
      <div role="status" className="flex flex-col items-center gap-3 px-4 py-16 text-center">
        <Loader size="lg" />
        <Text>{`Setting up ${info.name} in your browser…`}</Text>
      </div>
    );
  }
  if (district.status === "failed") {
    return (
      <div className="mx-auto max-w-xl p-8">
        <Empty title="The demo district didn't start" description="Use Reset demo to try again." />
      </div>
    );
  }
  const { roster } = district.district;
  if (persona.rostered === true && roster !== undefined && !roster.synced()) {
    const admin = info.personas.find((p) => p.id === "admin")!;
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 p-8 text-center">
        <Empty
          title={`${info.name} hasn't synced from Clever yet`}
          description={`${persona.name} comes from the district's Clever roster, which hasn't been brought in. Sign in as the administrator, ${admin.name}, and run the first sync from Roster sync.`}
        />
        <Button variant="primary" onClick={() => onChoose("admin", ROSTER_SYNC_ROUTE)}>{`Sign in as ${admin.name}`}</Button>
      </div>
    );
  }
  return <PersonaApp district={district.district} persona={persona} bearer={bearer ?? persona.subject} onStepsDone={onStepsDone} {...(onResponse === undefined ? {} : { onResponse })} {...(gradesRequest === undefined ? {} : { gradesRequest })} />;
};

interface PersonaAppProps {
  district: DemoDistrict;
  persona: Persona;
  bearer: string;
  onStepsDone: (ids: readonly string[]) => void;
  onResponse?: (request: Request, status: number) => void;
  gradesRequest?: number;
}

const PersonaApp = ({ district, persona, bearer, onStepsDone, onResponse, gradesRequest }: PersonaAppProps) => {
  // One client for the app's lifetime, as each app's own entry point makes one.
  const [client] = useState(() => district.clientFor(bearer, (request, response) => {
    onResponse?.(request, response.status);
    const ids = stepsDoneBy(persona.id, request, response.status, window.location.hash);
    if (ids.length > 0) onStepsDone(ids);
  }));
  const learningHome = persona.id === "student" || persona.id === "guardian";

  useEffect(() => {
    if (!learningHome) return;
    document.documentElement.dataset.app = "learning-home";
    return () => {
      delete document.documentElement.dataset.app;
    };
  }, [learningHome]);

  switch (persona.id) {
    case "student":
    case "guardian":
      return <LearningHome client={client} />;
    case "teacher":
      return (
        <DistrictApiProvider client={client}>
          {district.grades !== undefined && <Suspense><WhereItLanded grades={district.grades} {...(gradesRequest === undefined ? {} : { openRequest: gradesRequest })} /></Suspense>}
          <TeacherApp />
        </DistrictApiProvider>
      );
    case "admin":
      return <AdminConsole district={district} client={client} />;
  }
};

/**
 * The Learning Home, routed by hash: the demo is served from `/demo/`, and the app's routes start
 * at `/`, as Teacher Studio's and the admin console's hash routes do.
 */
const LearningHome = ({ client }: { client: DistrictApiClient }) => {
  const [history] = useState(() => createHashHistory());
  // The class helper's route is still to come (SCHO-107), and AI is off here regardless.
  return <StudentApp client={client} features={{ aiHelp: false }} history={history} />;
};

/**
 * The admin console. In a district whose roster the visitor has yet to sync, it opens at its Roster
 * sync screen, where the first sync is run, unless it was sent somewhere else.
 */
const AdminConsole = ({ district, client }: { district: DemoDistrict; client: DistrictApiClient }) => {
  // Before the console's first render, which reads the route from the hash.
  useState(() => {
    if (district.roster?.synced() === false && window.location.hash === "") window.history.replaceState(null, "", ROSTER_SYNC_ROUTE);
  });
  return <AdminApp client={client} />;
};
