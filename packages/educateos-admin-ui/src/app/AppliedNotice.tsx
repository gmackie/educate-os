import { useEffect, useRef } from "react";
import { Banner } from "@cloudflare/kumo";
import { CheckCircle } from "@phosphor-icons/react";

/**
 * What an applied change did, shown where the change's review stood. Applying closes the review
 * the administrator was reading, so focus moves here: otherwise it falls to the page, and the
 * message sits out of view above where they were.
 */
export const AppliedNotice = ({ message }: { message: string }) => {
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => { notice.current?.focus(); }, [message]);
  return (
    <div ref={notice} tabIndex={-1} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus">
      <Banner icon={<CheckCircle weight="fill" />} title={message} />
    </div>
  );
};
