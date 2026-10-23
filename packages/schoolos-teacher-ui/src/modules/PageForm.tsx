import { useState } from "react";
import { Button, Input, InputArea } from "@cloudflare/kumo";

/** The longest page the district stores, in characters. */
const MAX_PAGE_LENGTH = 20_000;

/**
 * A page's title and text, for a new page or an edit. The text is Markdown: students see headings,
 * lists, bold and italics, and links that open on their own; any HTML is shown as typed.
 */
export const PageForm = ({ label, initial, saving, submitLabel, onSave, onCancel }: {
  label: string;
  initial: { title: string; body: string };
  saving: boolean;
  submitLabel: string;
  onSave: (page: { title: string; body: string }) => Promise<boolean>;
  onCancel: () => void;
}) => {
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  return (
    <form
      aria-label={label}
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({ title: title.trim(), body });
      }}
    >
      <Input label="Page title" required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
      <InputArea
        label="Page text"
        description="Use # for headings, - for lists, **bold** and *italics*. Links must start with https://."
        autoResize
        minRows={6}
        maxLength={MAX_PAGE_LENGTH}
        value={body}
        onValueChange={setBody}
      />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={saving} disabled={title.trim() === ""}>{submitLabel}</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
};
