import { useState } from "react";
import { Button, Checkbox, Input, InputArea, Radio, Text } from "@cloudflare/kumo";
import { Plus } from "@phosphor-icons/react";
import { Problem } from "../Problem.tsx";
import { useAction } from "../modules/useAction.ts";
import type { Assignment, CourseModule } from "../types.ts";

const NONE = "none";

/**
 * Opening a discussion topic: its title and prompt, optionally the module it sits in (students see
 * it once that module is published) and the assignment its participation is graded under.
 */
export const TopicComposer = ({ offeringId, modules, assignments, onCreated }: {
  offeringId: string;
  modules: readonly CourseModule[];
  assignments: readonly Assignment[];
  onCreated: () => void;
}) => {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [moduleId, setModuleId] = useState(NONE);
  const [assignmentId, setAssignmentId] = useState(NONE);
  const [allowReplies, setAllowReplies] = useState(true);
  const action = useAction(onCreated);

  return (
    <form
      aria-label="Open a discussion"
      className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run("create", async (client) => {
          const module = modules.find((m) => m.id === moduleId);
          const topic = await client.call("teacher.createTopic", {
            params: { offeringId },
            body: {
              title: title.trim(),
              prompt,
              settings: { allowReplies },
              ...(module === undefined ? {} : { moduleId: module.id }),
              ...(assignmentId === NONE ? {} : { assignmentId }),
            },
          });
          setTitle("");
          setPrompt("");
          setModuleId(NONE);
          setAssignmentId(NONE);
          return module !== undefined && !module.published
            ? `Opened ${topic.title}. Students see it once you publish ${module.title}.`
            : `Opened ${topic.title} for the class.`;
        });
      }}
    >
      <h2><Text variant="heading" as="span">Open a discussion</Text></h2>
      <Input label="Topic" placeholder="Should the school day start later?" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
      <InputArea
        label="Prompt"
        description="What students respond to. Students see headings, lists, emphasis and links; never HTML."
        value={prompt}
        autoResize
        minRows={3}
        onValueChange={setPrompt}
      />
      {modules.length > 0 && (
        <Radio.Group legend="Place it in a module" value={moduleId} onValueChange={(value) => setModuleId(value as string)}>
          <Radio.Item value={NONE} label="No module" />
          {modules.map((m) => <Radio.Item key={m.id} value={m.id} label={m.published ? m.title : `${m.title} (draft)`} />)}
        </Radio.Group>
      )}
      {assignments.length > 0 && (
        <Radio.Group legend="Grade participation under" value={assignmentId} onValueChange={(value) => setAssignmentId(value as string)}>
          <Radio.Item value={NONE} label="Not graded" />
          {assignments.map((a) => <Radio.Item key={a.id} value={a.id} label={a.title} />)}
        </Radio.Group>
      )}
      <Checkbox label="Students can reply to each other's posts" checked={allowReplies} onCheckedChange={(on) => setAllowReplies(on === true)} />
      <div>
        <Button type="submit" variant="primary" icon={<Plus aria-hidden />} loading={action.running("create")} disabled={title.trim() === "" || action.busy}>
          Open discussion
        </Button>
      </div>
      {action.state.status === "failed" && <Problem error={action.state.error} />}
    </form>
  );
};
