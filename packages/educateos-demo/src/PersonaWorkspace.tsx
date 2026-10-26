import { useEffect, useState } from "react";
import { Empty, Loader, Text } from "@cloudflare/kumo";
import { createHashHistory } from "@tanstack/react-router";
import type { DistrictApiClient } from "@educateos/api-client";
import { AdminApp } from "@educateos/admin-ui/src/App.tsx";
import { StudentApp } from "@educateos/student-ui/src/App.tsx";
import { App as TeacherApp } from "@educateos/teacher-ui/src/App.tsx";
import { DistrictApiProvider } from "@educateos/teacher-ui/src/DistrictApi.tsx";
import type { DistrictState } from "./DemoApp.tsx";
import type { DemoDistrict, Persona } from "./demoDistrict.ts";
import { stepsDoneBy } from "./journeys.ts";

interface PersonaWorkspaceProps {
  district: DistrictState;
  persona: Persona;
  /** Called with the journey steps the persona's last request completed. */
  onStepsDone: (ids: readonly string[]) => void;
}

/** The persona's own app, once the district is up. */
export const PersonaWorkspace = ({ district, persona, onStepsDone }: PersonaWorkspaceProps) => {
  if (district.status === "booting") {
    return (
      <div role="status" className="flex flex-col items-center gap-3 px-4 py-16 text-center">
        <Loader size="lg" />
        <Text>Setting up Northfield Public Schools in your browser…</Text>
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
  return <PersonaApp district={district.district} persona={persona} onStepsDone={onStepsDone} />;
};

const PersonaApp = ({ district, persona, onStepsDone }: { district: DemoDistrict; persona: Persona; onStepsDone: (ids: readonly string[]) => void }) => {
  // One client for the app's lifetime, as each app's own entry point makes one.
  const [client] = useState(() => district.clientFor(persona.subject, (request, response) => {
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
      return <AdminApp client={client} />;
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
