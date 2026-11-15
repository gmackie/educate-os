import type { ComposerAttachment } from "../chat/composer/attachments/useComposerAttachments";
import { TeacherFileReview } from "./TeacherFileReview";

/** Inspect current uploads without reading connected services or sending a model request. */
export const TeacherMaterialReview = ({ attachments }: { attachments: readonly ComposerAttachment[] }) => {
  if (!attachments.length) return null;
  return <section aria-label="Review uploaded teaching sources" className="mx-4 my-3 flex flex-col gap-3">
    <h3 className="font-medium text-kumo-default">Check what can be read</h3>
    <p className="text-sm text-kumo-subtle">This file check runs on your device without AI. Attaching files still uploads originals to your personal workspace. Review the text and omissions before sending your brief. Use the attachment controls above to remove a file.</p>
    <ul className="flex flex-col gap-3">{attachments.map(attachment => <TeacherFileReview key={attachment.id} attachment={attachment} />)}</ul>
    <p className="text-sm text-kumo-subtle">A readable preview does not confirm rights or student suitability. Originals stay attached, and no lesson is published. Google connections are read separately after you send; this check does not read their contents.</p>
  </section>;
};
