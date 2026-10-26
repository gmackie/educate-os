import { useState } from "react";
import { Button, Dialog, Text } from "@cloudflare/kumo";
import { LoadState } from "../app/LoadState.tsx";
import { useLoad } from "../app/useLoad.ts";

/** The digest, once asked for: loaded only while the preview is open. */
const DigestBody = ({ guardianPrincipalId }: { guardianPrincipalId: string }) => {
  const preview = useLoad(`digest:${guardianPrincipalId}`, (client) => client.call("admin.previewDigest", { params: { guardianPrincipalId } }));
  return (
    <LoadState loaded={preview} what="the weekly digest" onRetry={preview.reload}>
      {(digest) => (
        <div className="flex flex-col gap-3">
          {digest.empty && <Text variant="secondary">There is nothing to tell them this week, so this digest would not be sent.</Text>}
          <div className="flex flex-col gap-1">
            <Text variant="secondary" size="sm">Subject</Text>
            <Text bold>{digest.subject}</Text>
          </div>
          {/* The plain-text part of the email: it says everything the HTML part does, and needs no sandbox to show. */}
          <pre aria-label="Digest text" className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-kumo-line bg-kumo-base p-3 font-sans text-sm text-kumo-default">
            {digest.text}
          </pre>
        </div>
      )}
    </LoadState>
  );
};

/**
 * What one guardian's next weekly email would say, as the district would send it: the subject and
 * the text, built from what their confirmed relationships let them read. Nothing is sent.
 */
export const DigestPreview = ({ guardianPrincipalId, guardianName }: { guardianPrincipalId: string; guardianName: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" aria-label={`Preview weekly digest for ${guardianName}`} onClick={() => setOpen(true)}>Preview weekly digest</Button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog className="flex flex-col gap-4 p-6" size="xl">
          <Dialog.Title className="text-lg font-semibold">{`${guardianName}'s weekly digest`}</Dialog.Title>
          <Dialog.Description className="text-kumo-subtle">A preview of their next weekly email. Nothing is sent.</Dialog.Description>
          {open && <DigestBody guardianPrincipalId={guardianPrincipalId} />}
          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
};
