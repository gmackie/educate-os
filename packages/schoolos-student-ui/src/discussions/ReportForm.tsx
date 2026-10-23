import { useState } from "react";
import { Banner, Button, Radio } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { postErrorMessage } from "./threadTree.ts";

const REASONS = [
  { value: "unkind", label: "It's unkind or hurtful" },
  { value: "unsafe", label: "It makes me worried about someone's safety" },
  { value: "off-topic", label: "It's off topic or spam" },
  { value: "other", label: "Something else" },
] as const;

/** Why a student reports a post. */
export type ReportReason = (typeof REASONS)[number]["value"];

/**
 * Telling the teacher about a post. Only the class's teachers see a report, and the post stays up
 * until one of them decides.
 */
export const ReportForm = ({ onReport, onCancel }: { onReport: (reason: ReportReason) => Promise<void>; onCancel: () => void }) => {
  const [reason, setReason] = useState<ReportReason | undefined>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-kumo-hairline p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (reason === undefined) return;
        setSending(true);
        setError(undefined);
        onReport(reason).catch((caught: unknown) => {
          setError(postErrorMessage(caught));
          setSending(false);
        });
      }}
    >
      <Radio.Group
        legend="Why are you reporting this post?"
        description="Only your teacher sees reports."
        value={reason}
        onValueChange={(value) => setReason(value as ReportReason)}
      >
        {REASONS.map(({ value, label }) => <Radio.Item key={value} value={value} label={label} />)}
      </Radio.Group>
      {error === undefined ? null : (
        <div role="alert">
          <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title="Not sent" description={error} />
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={sending} disabled={reason === undefined || sending}>Send to my teacher</Button>
        <Button size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
};
