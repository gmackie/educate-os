import { useEffect, useState } from "react";
import { Button, Empty, Loader, Text } from "@cloudflare/kumo";
import { createHashHistory } from "@tanstack/react-router";
import type { DistrictApiClient } from "@educateos/api-client";
import { AdminApp } from "@educateos/admin-ui/src/App.tsx";
import { StudentApp } from "@educateos/student-ui/src/App.tsx";
import { App as TeacherApp } from "@educateos/teacher-ui/src/App.tsx";
import { DistrictApiProvider } from "@educateos/teacher-ui/src/DistrictApi.tsx";
import { CleverSyncPanel } from "./CleverSyncPanel.tsx";
import type { DistrictState } from "./DemoApp.tsx";
import type { DemoDistrict, DistrictInfo, Persona, PersonaId } from "./districts/index.ts";
import { stepsDoneBy } from "./journeys.ts";

interface PersonaWorkspaceProps {
  info: DistrictInfo;
  district: DistrictState;
  persona: Persona;
  /** What the persona's requests carry, when the district signed them in to a session; else their subject. */
  bearer?: string;
  /** Called with the journey steps the persona's last request completed. */
  onStepsDone: (ids: readonly string[]) => void;
  /** Switches to another persona of the same district. */
  onChoose: (persona: PersonaId) => void;
}

/** The persona's own app, once the district is up, and its roster has brought the persona in. */
export const PersonaWorkspace = ({ info, district, persona, bearer, onStepsDone, onChoose }: PersonaWorkspaceProps) => {
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
          description={`${persona.name} comes from the district's Clever roster, which hasn't been brought in. Sign in as the administrator, ${admin.name}, and run the Clever sync.`}
        />
        <Button variant="primary" onClick={() => onChoose("admin")}>{`Sign in as ${admin.name}`}</Button>
      </div>
    );
  }
  return <PersonaApp district={district.district} persona={persona} bearer={bearer ?? persona.subject} onStepsDone={onStepsDone} />;
};

const PersonaApp = ({ district, persona, bearer, onStepsDone }: { district: DemoDistrict; persona: Persona; bearer: string; onStepsDone: (ids: readonly string[]) => void }) => {
  // One client for the app's lifetime, as each app's own entry point makes one.
  const [client] = useState(() => district.clientFor(bearer, (request, response) => {
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
 * The admin console, under the demo's Clever sync panel when the district's people come from one.
 * A sync changes the whole directory, so the console starts over to read it again.
 */
const AdminConsole = ({ district, client }: { district: DemoDistrict; client: DistrictApiClient }) => {
  const [syncs, setSyncs] = useState(0);
  return (
    <>
      {district.roster !== undefined && <CleverSyncPanel roster={district.roster} onSynced={() => setSyncs((n) => n + 1)} />}
      <AdminApp key={syncs} client={client} />
    </>
  );
};
