import { useState } from "react";
import { Badge, Button, LayerCard, Radio, Switch, Text } from "@cloudflare/kumo";
import { ArrowDown, ArrowUp, FileText, LinkSimple, NotePencil, Trash } from "@phosphor-icons/react";
import { Problem } from "../Problem.tsx";
import type { Assignment, CourseModule, CoursePage, ModuleItem } from "../types.ts";
import { PageForm } from "./PageForm.tsx";
import { useAction } from "./useAction.ts";

/** Where a module sits among the class's modules, so it can move up or down. */
interface ModulePosition {
  index: number;
  count: number;
  /** Every module's ID, in order. */
  order: readonly string[];
}

type Editing = { kind: "none" } | { kind: "new-page" } | { kind: "page"; pageId: string } | { kind: "activity" };

const moved = <T,>(list: readonly T[], from: number, to: number): T[] => {
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
};

/** One module: its title and status, its items in order, and the controls that change them. */
export const ModuleCard = ({ offeringId, module, pages, assignments, position, onChanged }: {
  offeringId: string;
  module: CourseModule;
  pages: readonly CoursePage[];
  assignments: readonly Assignment[];
  position: ModulePosition;
  onChanged: () => void;
}) => {
  const action = useAction(onChanged);
  const [editing, setEditing] = useState<Editing>({ kind: "none" });
  const [activityId, setActivityId] = useState("");
  const params = { offeringId, moduleId: module.id };
  const placed = new Set(module.items.flatMap((item) => (item.kind === "activity" ? [item.activityId] : [])));
  const placeable = assignments.filter((assignment) => !placed.has(assignment.activityId));
  const pageOf = (pageId: string) => pages.find((page) => page.id === pageId);

  const itemLabel = (item: ModuleItem): string => {
    switch (item.kind) {
      case "page":
        return pageOf(item.pageId)?.title ?? "Page";
      case "activity":
        return assignments.find((a) => a.activityId === item.activityId)?.title ?? "Activity";
      case "link":
        return item.title;
    }
  };

  const moveModule = (to: number) =>
    action.run("move", async (client) => {
      await client.call("teacher.reorderModules", { params: { offeringId }, body: { moduleIds: moved(position.order, position.index, to) } });
      return `Moved ${module.title} to position ${to + 1} of ${position.count}.`;
    });

  const moveItem = (from: number, to: number) =>
    action.run("move-item", async (client) => {
      const itemIds = moved(module.items.map((item) => item.id), from, to);
      await client.call("teacher.reorderModuleItems", { params, body: { itemIds } });
      return `Moved ${itemLabel(module.items[from]!)} to position ${to + 1}.`;
    });

  return (
    <LayerCard className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2><Text variant="heading" as="span">{module.title}</Text></h2>
          {module.published ? <Badge variant="success" appearance="dot">Published</Badge> : <Badge variant="neutral" appearance="dot">Draft</Badge>}
          {module.source?.kind === "cartridge" && <Badge variant="neutral">Imported</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Switch
            label="Visible to students"
            checked={module.published}
            disabled={action.busy}
            onClick={() =>
              void action.run("publish", async (client) => {
                await client.call("teacher.updateModule", { params, body: { published: !module.published } });
                return module.published ? `${module.title} is hidden from students.` : `${module.title} is published to students.`;
              })}
          />
          <Button size="sm" variant="ghost" shape="square" aria-label={`Move ${module.title} up`} icon={<ArrowUp aria-hidden />} disabled={action.busy || position.index === 0} onClick={() => void moveModule(position.index - 1)} />
          <Button size="sm" variant="ghost" shape="square" aria-label={`Move ${module.title} down`} icon={<ArrowDown aria-hidden />} disabled={action.busy || position.index === position.count - 1} onClick={() => void moveModule(position.index + 1)} />
          <Button
            size="sm"
            variant="secondary-destructive"
            icon={<Trash aria-hidden />}
            loading={action.running("delete")}
            disabled={action.busy}
            onClick={() =>
              void action.run("delete", async (client) => {
                await client.call("teacher.deleteModule", { params });
                return `Removed ${module.title} and its pages.`;
              })}
          >
            Remove module
          </Button>
        </div>
      </div>

      {module.items.length === 0
        ? <Text variant="secondary">Nothing in this module yet.</Text>
        : (
          <ol aria-label={`In ${module.title}`} className="flex flex-col divide-y divide-kumo-line">
            {module.items.map((item, index) => (
              <li key={item.id} className="flex flex-col gap-2 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    {item.kind === "page" ? <FileText aria-hidden /> : item.kind === "link" ? <LinkSimple aria-hidden /> : <NotePencil aria-hidden />}
                    <span>{itemLabel(item)}</span>
                    <Text variant="secondary" size="sm" as="span">{item.kind === "page" ? "Page" : item.kind === "link" ? "Link" : "Activity"}</Text>
                  </span>
                  <span className="flex gap-1">
                    {item.kind === "page" && (
                      <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => setEditing({ kind: "page", pageId: item.pageId })}>Edit</Button>
                    )}
                    <Button size="sm" variant="ghost" shape="square" aria-label={`Move ${itemLabel(item)} up`} icon={<ArrowUp aria-hidden />} disabled={action.busy || index === 0} onClick={() => void moveItem(index, index - 1)} />
                    <Button size="sm" variant="ghost" shape="square" aria-label={`Move ${itemLabel(item)} down`} icon={<ArrowDown aria-hidden />} disabled={action.busy || index === module.items.length - 1} onClick={() => void moveItem(index, index + 1)} />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${itemLabel(item)}`}
                      disabled={action.busy}
                      onClick={() =>
                        void action.run("remove", async (client) => {
                          await client.call("teacher.removeModuleItem", { params: { ...params, itemId: item.id } });
                          return `Removed ${itemLabel(item)} from ${module.title}.`;
                        })}
                    >
                      Remove
                    </Button>
                  </span>
                </div>
                {editing.kind === "page" && item.kind === "page" && editing.pageId === item.pageId && (
                  <PageForm
                    label={`Edit ${itemLabel(item)}`}
                    initial={{ title: pageOf(item.pageId)?.title ?? "", body: pageOf(item.pageId)?.body ?? "" }}
                    saving={action.running("save-page")}
                    submitLabel="Save page"
                    onCancel={() => setEditing({ kind: "none" })}
                    onSave={async (page) => {
                      const saved = await action.run("save-page", async (client) => {
                        await client.call("teacher.updatePage", { params: { offeringId, pageId: item.pageId }, body: page });
                        return `Saved ${page.title}.`;
                      });
                      if (saved) setEditing({ kind: "none" });
                      return saved;
                    }}
                  />
                )}
              </li>
            ))}
          </ol>
        )}

      {editing.kind === "new-page" && (
        <PageForm
          label={`New page in ${module.title}`}
          initial={{ title: "", body: "" }}
          saving={action.running("add-page")}
          submitLabel="Add page"
          onCancel={() => setEditing({ kind: "none" })}
          onSave={async (page) => {
            const saved = await action.run("add-page", async (client) => {
              await client.call("teacher.addPage", { params, body: page });
              return `Added ${page.title} to ${module.title}.`;
            });
            if (saved) setEditing({ kind: "none" });
            return saved;
          }}
        />
      )}

      {editing.kind === "activity" && (
        <form
          aria-label={`Add an activity to ${module.title}`}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run("place", async (client) => {
              await client.call("teacher.placeActivity", { params, body: { activityId } });
              setEditing({ kind: "none" });
              setActivityId("");
              return `Added ${assignments.find((a) => a.activityId === activityId)?.title ?? "the activity"} to ${module.title}.`;
            });
          }}
        >
          {placeable.length === 0
            ? <Text variant="secondary">Every activity in this class is already in this module. Create one under Create activity.</Text>
            : (
              <Radio.Group legend="Activity" value={activityId} onValueChange={(value) => setActivityId(String(value))}>
                {placeable.map((assignment) => <Radio.Item key={assignment.activityId} value={assignment.activityId} label={assignment.title} />)}
              </Radio.Group>
            )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={action.running("place")} disabled={activityId === ""}>Add activity</Button>
            <Button type="button" variant="secondary" onClick={() => setEditing({ kind: "none" })}>Cancel</Button>
          </div>
        </form>
      )}

      {editing.kind === "none" && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon={<FileText aria-hidden />} onClick={() => setEditing({ kind: "new-page" })}>Add page</Button>
          <Button size="sm" variant="secondary" icon={<NotePencil aria-hidden />} onClick={() => setEditing({ kind: "activity" })}>Add activity</Button>
        </div>
      )}
      {action.state.status === "failed" && <Problem error={action.state.error} />}
    </LayerCard>
  );
};
