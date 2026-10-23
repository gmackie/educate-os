import { useState } from "react";
import { Button, Empty, Input } from "@cloudflare/kumo";
import { Plus, Stack } from "@phosphor-icons/react";
import { useAnnounce } from "../Announcer.tsx";
import { classLabel } from "../classes/classLabel.ts";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Loading } from "../Loading.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import type { Assignment, CourseOutline, TeachingOffering } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { CartridgePanel } from "./CartridgePanel.tsx";
import { ModuleCard } from "./ModuleCard.tsx";

interface ModulesData {
  outline: CourseOutline;
  assignments: Assignment[];
}

/**
 * A class's modules, in the order students meet them: the teacher adds modules, writes pages,
 * places the class's activities, and publishes each module when it is ready. Drafts stay with the
 * class's teachers.
 */
export const ModulesPage = ({ teaching }: { teaching: TeachingOffering }) => {
  const offeringId = teaching.offering.id;
  const content = useLoad(`modules:${offeringId}`, async (client): Promise<ModulesData> => {
    const [view, assignments] = await Promise.all([
      client.call("teacher.listModules", { params: { offeringId } }),
      client.call("teacher.listAssignments", { params: { offeringId } }),
    ]);
    return { outline: view.outline, assignments };
  });
  // After each change the page reloads; the modules stay on screen meanwhile, so a teacher's
  // place, focus and open forms survive instead of flashing back to a loading state.
  const [last, setLast] = useState<{ offeringId: string; data: ModulesData }>();
  const ready = content.status === "ready" ? content.data : undefined;
  if (ready !== undefined && last?.data !== ready) setLast({ offeringId, data: ready });
  const data = ready ?? (last?.offeringId === offeringId ? last.data : undefined);

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>{`Modules · ${classLabel(teaching)}`}</PageHeading>
      <NewModuleForm offeringId={offeringId} onCreated={content.reload} />
      {content.status === "loading" && data === undefined && <Loading label="Loading the modules…" />}
      {content.status === "error" && <Problem error={content.error} onRetry={content.reload} />}
      {data !== undefined && data.outline.modules.length === 0 && (
        <Empty icon={<Stack size={32} aria-hidden />} title="No modules yet" description="Add a module, or import a Common Cartridge from another learning system." />
      )}
      {data !== undefined && data.outline.modules.length > 0 && (
        <ol aria-label="Modules" className="flex flex-col gap-4">
          {data.outline.modules.map((module, index, modules) => (
            <li key={module.id}>
              <ModuleCard
                offeringId={offeringId}
                module={module}
                pages={data.outline.pages}
                assignments={data.assignments}
                position={{ index, count: modules.length, order: modules.map((m) => m.id) }}
                onChanged={content.reload}
              />
            </li>
          ))}
        </ol>
      )}
      <CartridgePanel offeringId={offeringId} onImported={content.reload} />
    </div>
  );
};

const NewModuleForm = ({ offeringId, onCreated }: { offeringId: string; onCreated: () => void }) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const [title, setTitle] = useState("");
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "failed"; error: unknown }>({ status: "idle" });

  const create = async () => {
    setState({ status: "saving" });
    try {
      const module = await client.call("teacher.createModule", { params: { offeringId }, body: { title: title.trim() } });
      setTitle("");
      setState({ status: "idle" });
      announce(`Added ${module.title}. Students see it once you publish it.`);
      onCreated();
    } catch (error) {
      setState({ status: "failed", error });
    }
  };

  return (
    <form
      aria-label="Add a module"
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="grow">
          <Input label="New module" placeholder="Week 1: Getting started" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
        </div>
        <Button type="submit" variant="primary" icon={<Plus aria-hidden />} loading={state.status === "saving"} disabled={title.trim() === ""}>
          Add module
        </Button>
      </div>
      {state.status === "failed" && <Problem error={state.error} />}
    </form>
  );
};
