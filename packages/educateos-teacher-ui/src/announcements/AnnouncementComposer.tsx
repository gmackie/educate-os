import { useState } from "react";
import { Button, Checkbox, Input, InputArea } from "@cloudflare/kumo";
import { toLocalInput } from "../dates.ts";
import type { ClassAnnouncement } from "../types.ts";

/** What a teacher posts: a title, plain text, and optionally when students should first see it. */
export interface AnnouncementDraft {
  title: string;
  body: string;
  /** A UTC timestamp, or absent to publish at once. */
  publishAt?: string;
}

/** The longest announcement the district stores, in characters. */
const MAX_BODY_LENGTH = 10_000;

/**
 * Writes a new announcement to the class, or changes one already posted. Students see it at once,
 * or from a scheduled time the teacher picks in their own time zone; one students can already see
 * keeps its posting time. The text is shown to students exactly as typed. What was typed is kept
 * if saving fails.
 */
export const AnnouncementComposer = ({ saving, onPost, editing }: {
  saving: boolean;
  onPost: (draft: AnnouncementDraft) => Promise<boolean>;
  /** The announcement being changed, and how to stop without saving. A new one when absent. */
  editing?: { entry: ClassAnnouncement; onCancel: () => void };
}) => {
  const original = editing?.entry;
  const [title, setTitle] = useState(original?.announcement.title ?? "");
  const [body, setBody] = useState(original?.announcement.body ?? "");
  const [scheduled, setScheduled] = useState(original !== undefined && !original.published);
  const [publishAt, setPublishAt] = useState(original !== undefined && !original.published ? toLocalInput(original.announcement.publishAt) : "");
  const canSchedule = original === undefined || !original.published;
  const ready = title.trim() !== "" && body.trim() !== "" && (!scheduled || publishAt !== "");
  const submitLabel = original !== undefined ? "Save changes" : scheduled ? "Schedule announcement" : "Post announcement";

  return (
    <form
      aria-label={original === undefined ? "New announcement" : `Edit ${original.announcement.title}`}
      className="flex flex-col gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!ready) return;
        const posted = await onPost({
          title: title.trim(),
          body: body.trim(),
          // A datetime-local value is the teacher's local time; the district stores UTC. A scheduled
          // announcement changed to "now" is published now.
          ...(scheduled
            ? { publishAt: new Date(publishAt).toISOString() }
            : original !== undefined && !original.published ? { publishAt: new Date().toISOString() } : {}),
        });
        if (posted && original === undefined) {
          setTitle("");
          setBody("");
          setScheduled(false);
          setPublishAt("");
        }
      }}
    >
      <Input label="Title" required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
      <InputArea label="Message" description="Students see this text exactly as you type it." autoResize minRows={4} maxLength={MAX_BODY_LENGTH} value={body} onValueChange={setBody} />
      {canSchedule && <Checkbox label="Schedule for later" checked={scheduled} onCheckedChange={(on) => setScheduled(on === true)} />}
      {scheduled ? (
        <Input label="Publish at" type="datetime-local" required value={publishAt} onChange={(event) => setPublishAt(event.target.value)} />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={saving} disabled={!ready}>{submitLabel}</Button>
        {editing !== undefined && <Button type="button" variant="secondary" onClick={editing.onCancel}>Cancel</Button>}
      </div>
    </form>
  );
};
