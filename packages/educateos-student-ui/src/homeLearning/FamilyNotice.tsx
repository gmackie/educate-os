import { useState, type ReactNode } from "react";
import { Banner, Button, Checkbox, Surface } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";
import { messageFor, useApi } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { useFamily } from "./useFamily.ts";

/** The family notice, as the server states it for this installation. */
export type FamilyNoticeView = RouteResponse<"family.home">["notice"];

/** The notice's text: how a family's information is kept. */
export const NoticeText = ({ notice, headingLevel = 2 }: { notice: FamilyNoticeView; headingLevel?: 2 | 3 }) => {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className="flex flex-col gap-3">
      <Heading className="text-lg font-semibold">{notice.title}</Heading>
      {notice.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
    </div>
  );
};

/** The notice with the checkbox an adult ticks to accept it. */
export const NoticeAcceptance = ({ notice, accepted, onChange }: { notice: FamilyNoticeView; accepted: boolean; onChange: (accepted: boolean) => void }) => (
  <Surface className="flex flex-col gap-4 rounded-xl border border-kumo-hairline p-5">
    <NoticeText notice={notice} />
    <Checkbox label="I've read this and agree" checked={accepted} onCheckedChange={(checked) => onChange(checked === true)} />
  </Surface>
);

/**
 * Asks a family adult who hasn't accepted the current notice (it changed, or they joined before it
 * existed) to read and accept it before any family page.
 */
export const NoticeGate = ({ children }: { children: ReactNode }) => {
  const api = useApi();
  const [home, reload] = useFamily();
  const [accepted, setAccepted] = useState(false);
  const [state, setState] = useState<{ status: "idle" | "sending" } | { status: "failed"; message: string }>({ status: "idle" });
  if (home.status === "loading") return <LoadingSkeleton label="Loading home learning" />;
  if (home.status === "error") return <ErrorState error={home.error} title="We couldn't load home learning" onRetry={reload} />;
  if (home.data.family === null || home.data.noticeAccepted) return children;
  const { notice } = home.data;
  return (
    <section aria-labelledby="family-notice" className="flex max-w-2xl flex-col gap-6">
      <PageHeading id="family-notice">Before you carry on</PageHeading>
      <p>Please read how your family's information is kept here.</p>
      <NoticeAcceptance notice={notice} accepted={accepted} onChange={setAccepted} />
      {state.status === "failed" ? <div role="alert"><Banner variant="error" title="That didn't work" description={state.message} /></div> : null}
      <Button variant="primary" className="self-start" disabled={!accepted} loading={state.status === "sending"} onClick={() => {
        setState({ status: "sending" });
        api.call("family.acceptNotice", { body: { version: notice.version } }).then(() => {
          setState({ status: "idle" });
          reload();
        }, (caught: unknown) => setState({ status: "failed", message: messageFor(caught) }));
      }}>Continue</Button>
    </section>
  );
};
