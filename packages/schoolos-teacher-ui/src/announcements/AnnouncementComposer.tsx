import { useState } from "react";
import { Button, Checkbox, Input, InputArea } from "@cloudflare/kumo";

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
 * Writes a new announcement to the class. Students see it at once, or from a scheduled time the
 * teacher picks in their own time zone. The text is shown to students exactly as typed. What was
 * typed is kept if posting fails.
 */
export const AnnouncementComposer = ({ saving, onPost }: { saving: boolean; onPost: (draft: AnnouncementDraft) => Promise<boolean> }) => {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [scheduled, setScheduled] = useState(false);
  const [publishAt, setPublishAt] = useState("");
  const ready = title.trim() !== "" && body.trim() !== "" && (!scheduled || publishAt !== "");

  return (
    <form
      aria-label="New announcement"
      className="flex flex-col gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!ready) return;
        const posted = await onPost({
          title: title.trim(),
          body: body.trim(),
          // A datetime-local value is the teacher's local time; the district stores UTC.
          ...(scheduled ? { publishAt: new Date(publishAt).toISOString() } : {}),
        });
        if (posted) {
          setTitle("");
          setBody("");
          setScheduled(false);
          setPublishAt("");
        }
      }}
    >
      <Input label="Title" required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
      <InputArea label="Message" description="Students see this text exactly as you type it." autoResize minRows={4} maxLength={MAX_BODY_LENGTH} value={body} onValueChange={setBody} />
      <Checkbox label="Schedule for later" checked={scheduled} onCheckedChange={(on) => setScheduled(on === true)} />
      {scheduled ? (
        <Input label="Publish at" type="datetime-local" required value={publishAt} onChange={(event) => setPublishAt(event.target.value)} />
      ) : null}
      <div>
        <Button type="submit" variant="primary" loading={saving} disabled={!ready}>
          {scheduled ? "Schedule announcement" : "Post announcement"}
        </Button>
      </div>
    </form>
  );
};
