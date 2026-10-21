import { useState } from "react";
import { Banner, Button, Dialog, Text } from "@cloudflare/kumo";
import { CheckCircleIcon, PaperPlaneTiltIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { messageFor, useApi } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { formatDateTime, receiptCode } from "../labels.ts";
import type { Assignment, SubmissionReceipt } from "../model.ts";

/** A piece of saved work that a submission would include. */
export interface SubmittableWork {
  title: string;
  artifactId: string;
  revisionId: string;
}

/** The proof of a submission: its receipt code, when it arrived and whether it was on time. */
export const ReceiptDetails = ({ receipt }: { receipt: SubmissionReceipt }) => (
  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
    <dt className="text-kumo-subtle">Receipt code</dt>
    <dd className="font-mono font-semibold">{receiptCode(receipt.submissionDigest)}</dd>
    <dt className="text-kumo-subtle">Submitted</dt>
    <dd>
      <time dateTime={receipt.submittedAt}>{formatDateTime(receipt.submittedAt)}</time>
      {receipt.timing === "late" ? " (late)" : ""}
    </dd>
    <dt className="text-kumo-subtle">Attempt</dt>
    <dd>{receipt.attempt}</dd>
  </dl>
);

/**
 * Submit: a confirmation that lists exactly the saved versions being handed in, then the receipt.
 * Unsaved changes block it, because a submission captures saved versions only and the student would
 * otherwise hand in something other than what is on their screen.
 */
export const SubmitSection = ({ assignment, work, unsaved, onSubmitted }: {
  assignment: Assignment;
  work: SubmittableWork[];
  unsaved: boolean;
  onSubmitted: (receipt: SubmissionReceipt) => void;
}) => {
  const api = useApi();
  const announce = useAnnounce();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<SubmissionReceipt | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const blocked = unsaved ? "Save your changes before you submit." : work.length === 0 ? "Save some work before you submit." : undefined;

  const submit = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      const done = await api.call("student.submit", {
        params: { assignmentId: assignment.id },
        body: { revisions: work.map(({ artifactId, revisionId }) => ({ artifactId, revisionId })) },
      });
      setReceipt(done);
      onSubmitted(done);
      announce(`Submitted. Your receipt code is ${receiptCode(done.submissionDigest)}.`);
    } catch (caught) {
      setError(messageFor(caught));
      announce("Your work was not submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  const onOpenChange = (next: boolean) => {
    if (submitting) return;
    setOpen(next);
    if (!next) setError(undefined);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={<PaperPlaneTiltIcon aria-hidden />} disabled={blocked !== undefined} aria-describedby={blocked === undefined ? undefined : "submit-blocked"} onClick={() => (setReceipt(undefined), setOpen(true))}>
          Submit
        </Button>
        {blocked === undefined ? null : (
          <Text variant="secondary" size="sm">
            <span id="submit-blocked">{blocked}</span>
          </Text>
        )}
      </div>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog className="flex flex-col gap-4 p-6" size="lg">
          {receipt === undefined ? (
            <>
              <Dialog.Title className="text-xl font-semibold">Submit your work?</Dialog.Title>
              <Dialog.Description className="text-kumo-subtle">
                Your teacher will see these saved versions. You can keep working afterwards; each submission is kept separately.
              </Dialog.Description>
              <ul className="list-disc pl-6">
                {work.map((item) => (
                  <li key={item.artifactId}>{item.title}</li>
                ))}
              </ul>
              <Text variant="secondary" size="sm">
                You can submit this activity up to {assignment.attemptsAllowed} {assignment.attemptsAllowed === 1 ? "time" : "times"}.
              </Text>
              {error === undefined ? null : (
                <div role="alert">
                  <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title="Not submitted" description={error} />
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Dialog.Close render={(props) => <Button {...props} disabled={submitting}>Cancel</Button>} />
                <Button variant="primary" loading={submitting} onClick={() => void submit()}>
                  Submit
                </Button>
              </div>
            </>
          ) : (
            <>
              <Dialog.Title className="flex items-center gap-2 text-xl font-semibold">
                <CheckCircleIcon aria-hidden weight="fill" className="text-kumo-success" />
                Submitted
              </Dialog.Title>
              <Dialog.Description className="text-kumo-subtle">Keep your receipt code. It shows exactly what you handed in.</Dialog.Description>
              <ReceiptDetails receipt={receipt} />
              <div className="flex justify-end">
                <Dialog.Close render={(props) => <Button {...props} variant="primary">Done</Button>} />
              </div>
            </>
          )}
        </Dialog>
      </Dialog.Root>
    </div>
  );
};
