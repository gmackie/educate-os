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
 * otherwise hand in something other than what is on their screen. Young learners get the same
 * steps in plainer words: "I'm done!", then "Yes, hand it in", without the attempt limit or the
 * receipt code, which are for older students and the grown-ups (the teacher sees every attempt and
 * its receipt).
 */
export const SubmitSection = ({ assignment, work, unsaved, young = false, onSubmitted }: {
  assignment: Assignment;
  /** The young-learner presentation. */
  young?: boolean;
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
  const blocked = unsaved
    ? (young ? "Save your work first." : "Save your changes before you submit.")
    : work.length === 0 ? (young ? "Make something and save it first." : "Save some work before you submit.") : undefined;

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
      announce(young ? "You did it! Your work is handed in." : `Submitted. Your receipt code is ${receiptCode(done.submissionDigest)}.`);
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
        <Button
          variant="primary"
          size={young ? "lg" : "base"}
          className={young ? "min-h-16 px-8 text-2xl" : undefined}
          icon={young ? <CheckCircleIcon aria-hidden weight="fill" size={32} /> : <PaperPlaneTiltIcon aria-hidden />}
          disabled={blocked !== undefined}
          aria-describedby={blocked === undefined ? undefined : "submit-blocked"}
          onClick={() => (setReceipt(undefined), setOpen(true))}
        >
          {young ? "I'm done!" : "Submit"}
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
              <Dialog.Title className="text-xl font-semibold">{young ? "Hand in your work?" : "Submit your work?"}</Dialog.Title>
              <Dialog.Description className="text-kumo-subtle">
                {young
                  ? "Your teacher will see this work."
                  : "Your teacher will see these saved versions. You can keep working afterwards; each submission is kept separately."}
              </Dialog.Description>
              <ul className="list-disc pl-6">
                {work.map((item) => (
                  <li key={item.artifactId}>{item.title}</li>
                ))}
              </ul>
              {young ? null : (
                <Text variant="secondary" size="sm">
                  You can submit this activity up to {assignment.attemptsAllowed} {assignment.attemptsAllowed === 1 ? "time" : "times"}.
                </Text>
              )}
              {error === undefined ? null : (
                <div role="alert">
                  <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title="Not submitted" description={error} />
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Dialog.Close render={(props) => <Button {...props} size={young ? "lg" : "base"} disabled={submitting}>{young ? "Not yet" : "Cancel"}</Button>} />
                <Button variant="primary" size={young ? "lg" : "base"} loading={submitting} onClick={() => void submit()}>
                  {young ? "Yes, hand it in" : "Submit"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Dialog.Title className="flex items-center gap-2 text-xl font-semibold">
                <CheckCircleIcon aria-hidden weight="fill" className="text-kumo-success" />
                {young ? "You did it!" : "Submitted"}
              </Dialog.Title>
              <Dialog.Description className="text-kumo-subtle">
                {young ? "Your work is handed in. Your teacher will see it soon." : "Keep your receipt code. It shows exactly what you handed in."}
              </Dialog.Description>
              {young ? null : <ReceiptDetails receipt={receipt} />}
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
