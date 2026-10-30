import { useEffect } from "react";
import { Select } from "@cloudflare/kumo";
import type { Workspace } from "../../shared/api.ts";

/** Chooses which workspace a people or devices screen reads from. */
export const WorkspacePicker = ({ workspaces, value, onChange }: { workspaces: Workspace[]; value: string | undefined; onChange: (id: string) => void }) => {
  const first = workspaces[0]?.id;
  useEffect(() => {
    if (value === undefined && first !== undefined) onChange(first);
  }, [value, first, onChange]);
  const name = (id: string | null) => workspaces.find((w) => w.id === id)?.displayName ?? "Choose a workspace";
  return (
    <Select<string | null> label="Workspace" className="min-w-56" value={value ?? null} renderValue={name} onValueChange={(id) => { if (id !== null) onChange(id); }}>
      {workspaces.map((w) => <Select.Option key={w.id} value={w.id}>{w.displayName}</Select.Option>)}
    </Select>
  );
};
