import { useState } from "react";
import { Banner, Button, InputArea } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { postErrorMessage } from "./threadTree.ts";

/** The longest post the district accepts, in characters. */
const MAX_POST_LENGTH = 10_000;

/**
 * Writing a post, a reply or an edit. `onSubmit` sends the text; a refusal (screening, a locked
 * topic) is shown beside the text, which is kept so the student can change it and try again.
 */
export const PostComposer = ({ label, submitLabel, initialText = "", onSubmit, onCancel }: {
  label: string;
  submitLabel: string;
  initialText?: string;
  onSubmit: (text: string) => Promise<void>;
  onCancel?: () => void;
}) => {
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const tooLong = text.length > MAX_POST_LENGTH;

  const send = async () => {
    setSending(true);
    setError(undefined);
    try {
      await onSubmit(text);
      setText("");
    } catch (caught) {
      setError(postErrorMessage(caught));
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <InputArea
        label={label}
        value={text}
        autoResize
        minRows={3}
        maxRows={12}
        onValueChange={setText}
        {...(tooLong ? { variant: "error" as const, error: `Keep it under ${MAX_POST_LENGTH.toLocaleString("en-US")} characters.` } : {})}
      />
      {error === undefined ? null : (
        <div role="alert">
          <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title="Not sent" description={error} />
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={sending} disabled={sending || tooLong || text.trim() === ""}>
          {submitLabel}
        </Button>
        {onCancel === undefined ? null : <Button size="sm" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
};
