import { useState } from "react";
import { Button, Input, Text } from "@cloudflare/kumo";
import { PaperPlaneTilt } from "@phosphor-icons/react";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Problem } from "../Problem.tsx";
import type { ActivityDefinition, Assignment, RubricRef } from "../types.ts";

/** The end of the given local day, as the instant students' work is due. */
const endOfDay = (date: string): string => new Date(`${date}T23:59:00`).toISOString();

/** Publishes the previewed activity and assigns it to the class with a due date. */
export const PublishPanel = ({ definition, offeringId, rubric, onPublished }: {
  definition: ActivityDefinition;
  offeringId: string;
  rubric: RubricRef | undefined;
  onPublished: (assignment: Assignment) => void;
}) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const [due, setDue] = useState("");
  const [state, setState] = useState<{ status: "idle" | "publishing" } | { status: "failed"; error: unknown }>({ status: "idle" });

  const publish = async () => {
    setState({ status: "publishing" });
    try {
      const published = definition.status === "published"
        ? definition
        : await client.call("teacher.publishActivity", { params: { definitionId: definition.id } });
      const { assignment } = await client.call("teacher.installActivity", {
        params: { definitionId: published.id },
        body: {
          offeringId,
          version: published.version,
          assignment: { ...(due === "" ? {} : { dueAt: endOfDay(due) }), ...(rubric === undefined ? {} : { rubric }) },
        },
      });
      announce(`${assignment.title} is published and assigned.`);
      onPublished(assignment);
    } catch (error) {
      setState({ status: "failed", error });
    }
  };

  return (
    <form
      aria-label="Publish and assign"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void publish();
      }}
    >
      <Input label="Due date" type="date" required={false} description="Leave empty to make it due at the end of the term." value={due} onChange={(event) => setDue(event.target.value)} />
      <Text variant="secondary" size="sm">Once published, students in this class can open it. Later changes make a new version and don't change what they already have.</Text>
      <div>
        <Button type="submit" variant="primary" icon={<PaperPlaneTilt aria-hidden />} loading={state.status === "publishing"}>Publish and assign</Button>
      </div>
      {state.status === "failed" && <Problem error={state.error} />}
    </form>
  );
};
