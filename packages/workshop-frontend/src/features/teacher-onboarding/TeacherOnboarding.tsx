import { useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo";
import { readComposerDraft } from "../chat/composer/draft/composerDraft";
import { TeacherIntake } from "./TeacherIntake";

export const TeacherOnboarding = ({ composer, draftStorageKey, onPrepare, onBack }: {
  composer: ReactNode;
  draftStorageKey: string | undefined;
  onPrepare: (brief: string) => void;
  onBack: () => void;
}) => {
  const [prepared, setPrepared] = useState(() => Boolean(readComposerDraft(draftStorageKey)?.text));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 sm:px-8">
      <header className="flex flex-col gap-3">
        <div><Button variant="ghost" onClick={onBack}>Back to home</Button></div>
        <h1 className="text-3xl font-semibold tracking-tight text-kumo-default">Bring your classroom into EducateOS</h1>
        <p className="text-kumo-subtle">Start with your own teaching materials. You can prepare a lesson in your personal workspace before joining a school-managed class.</p>
      </header>
      {!draftStorageKey ? (
        <p role="status" className="text-kumo-subtle">Loading your classroom brief…</p>
      ) : !prepared ? (
        <TeacherIntake onPrepare={(text) => {
          onPrepare(text);
          setPrepared(true);
        }} />
      ) : (
        <section aria-labelledby="teacher-brief-heading" className="flex flex-col gap-4">
          <h2 id="teacher-brief-heading" className="text-lg font-medium text-kumo-default">Review your brief and add materials</h2>
          <p className="text-sm text-kumo-subtle">Edit the request below, paste a useful excerpt, or use the + menu to attach files and choose available connections. Start with one PDF or Word (.docx) lesson. File limits are 4 MiB each and 5 MiB total. Send when you’re ready to ask AI for options.</p>
          <p className="text-sm text-kumo-subtle">Your original files are kept. Word imports use body text; images, comments and page layout may be missing. PDFs depend on the selected AI model and available text. For scans, slides or older Word files, paste an excerpt or export readable text. AI will ask for another source if it cannot read a document.</p>
          <p className="text-sm text-kumo-subtle">Your brief is separate from your home draft. Connecting an account does not enroll students or enable school roster and grade integrations.</p>
          {composer}
        </section>
      )}
    </div>
  );
};
