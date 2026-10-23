import { useState } from "react";
import { Button, Input, Text } from "@cloudflare/kumo";
import { CalendarCheck } from "@phosphor-icons/react";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Problem } from "../Problem.tsx";
import type { Assignment } from "../types.ts";

const pad = (n: number) => String(n).padStart(2, "0");

/** An instant as a `datetime-local` value, in the teacher's own time zone. */
const toLocalInput = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * Moves an assignment's due date. The field is a native date-and-time input, read in the teacher's
 * time zone and sent as an instant, so students everywhere see the same deadline. Work already
 * turned in keeps the on-time or late mark it arrived with.
 */
export const DueDateEditor = ({ assignment, onChanged }: { assignment: Assignment; onChanged: (updated: Assignment) => void }) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const saved = toLocalInput(assignment.dueAt);
  const [value, setValue] = useState(saved);
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "failed"; error: unknown }>({ status: "idle" });
  const due = new Date(value);
  const valid = value !== "" && !Number.isNaN(due.getTime());

  const save = async () => {
    setState({ status: "saving" });
    try {
      const updated = await client.call("teacher.updateAssignment", { params: { assignmentId: assignment.id }, body: { dueAt: due.toISOString() } });
      setState({ status: "idle" });
      announce(`Due date for ${updated.title} changed to ${new Date(updated.dueAt).toLocaleString()}.`);
      onChanged(updated);
    } catch (error) {
      setState({ status: "failed", error });
    }
  };

  return (
    <form
      aria-label={`Due date for ${assignment.title}`}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="grow">
          <Input
            type="datetime-local"
            label="Due date and time"
            description="Students see the new date straight away. Work turned in after it is marked late."
            value={value}
            onChange={(event) => setValue(event.target.value)}
            {...(valid || value === saved ? {} : { error: "Enter a date and time." })}
          />
        </div>
        <Button type="submit" icon={<CalendarCheck aria-hidden />} disabled={!valid || value === saved} loading={state.status === "saving"}>
          Save due date
        </Button>
      </div>
      {assignment.latePolicy.kind === "refuse" && <Text variant="secondary" size="sm">This activity doesn't accept late work.</Text>}
      {state.status === "failed" && <Problem error={state.error} />}
    </form>
  );
};
