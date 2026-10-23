import { useState } from "react";
import { Badge, Button, Text } from "@cloudflare/kumo";
import { CaretDown, CaretRight, LockSimple, LockSimpleOpen, PushPin, PushPinSlash, Trash } from "@phosphor-icons/react";
import { Problem } from "../Problem.tsx";
import { useAction } from "../modules/useAction.ts";
import type { Assignment, CourseModule, DiscussionTopic } from "../types.ts";
import { StaffThread } from "./StaffThread.tsx";

/**
 * One topic as its teachers manage it: where it sits and whether it is graded, how many posts need
 * them, pinning and closing it, deleting it, and its posts.
 */
export const TopicCard = ({ topic, posts, needsAttention, modules, assignments, onChanged }: {
  topic: DiscussionTopic;
  posts: number;
  needsAttention: number;
  modules: readonly CourseModule[];
  assignments: readonly Assignment[];
  onChanged: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const action = useAction(onChanged);
  const params = { offeringId: topic.offeringId, topicId: topic.id };
  const module = modules.find((m) => m.id === topic.moduleId);
  const graded = assignments.find((a) => a.id === topic.assignmentId);
  const panelId = `staff-topic-${topic.id}`;

  const update = (name: string, body: { pinned?: boolean; locked?: boolean }, done: string) =>
    void action.run(name, async (client) => {
      await client.call("teacher.updateTopic", { params, body });
      return done;
    });

  return (
    <section aria-label={topic.title} className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3>
          <Button variant="ghost" aria-expanded={open} aria-controls={panelId} icon={open ? <CaretDown aria-hidden /> : <CaretRight aria-hidden />} onClick={() => setOpen(!open)}>
            {topic.title}
          </Button>
        </h3>
        {topic.pinned && <Badge variant="neutral">Pinned</Badge>}
        {topic.locked && <Badge variant="neutral">Closed</Badge>}
        {module !== undefined && <Badge variant="secondary">{module.published ? `In ${module.title}` : `In ${module.title} (draft: students can't see it yet)`}</Badge>}
        {graded !== undefined && <Badge variant="info">{`Graded: ${graded.title}`}</Badge>}
        <Text variant="secondary" size="sm" as="span">{posts === 1 ? "1 post" : `${posts} posts`}</Text>
        {needsAttention > 0 && <Badge variant="warning">{`${needsAttention} need${needsAttention === 1 ? "s" : ""} you`}</Badge>}
      </div>
      <div role="group" aria-label={`Manage ${topic.title}`} className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={topic.pinned ? <PushPinSlash aria-hidden /> : <PushPin aria-hidden />} loading={action.running("pin")} disabled={action.busy}
          onClick={() => update("pin", { pinned: !topic.pinned }, topic.pinned ? "Unpinned." : "Pinned to the top.")}>
          {topic.pinned ? "Unpin" : "Pin"}
        </Button>
        <Button size="sm" variant="secondary" icon={topic.locked ? <LockSimpleOpen aria-hidden /> : <LockSimple aria-hidden />} loading={action.running("lock")} disabled={action.busy}
          onClick={() => update("lock", { locked: !topic.locked }, topic.locked ? "Reopened for students' posts." : "Closed: students can read it but not post.")}>
          {topic.locked ? "Reopen" : "Close to new posts"}
        </Button>
        {confirmingDelete
          ? (
            <>
              <Text size="sm" as="span">Delete this topic and every post in it?</Text>
              <Button size="sm" variant="primary" loading={action.running("delete")} disabled={action.busy}
                onClick={() => void action.run("delete", async (client) => {
                  await client.call("teacher.deleteTopic", { params });
                  return `Deleted ${topic.title}.`;
                })}>
                Delete topic
              </Button>
              <Button size="sm" onClick={() => setConfirmingDelete(false)}>Keep it</Button>
            </>
          )
          : <Button size="sm" variant="ghost" icon={<Trash aria-hidden />} onClick={() => setConfirmingDelete(true)}>Delete</Button>}
      </div>
      {action.state.status === "failed" && <Problem error={action.state.error} />}
      <div id={panelId} hidden={!open}>
        {open && (
          <div className="flex flex-col gap-3">
            <Text as="p"><span className="whitespace-pre-line">{topic.prompt}</span></Text>
            <StaffThread topic={topic} onChanged={onChanged} />
          </div>
        )}
      </div>
    </section>
  );
};
