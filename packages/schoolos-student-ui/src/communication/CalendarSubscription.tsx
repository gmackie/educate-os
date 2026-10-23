import { useState } from "react";
import { Banner, Button, Input, Text } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { formatDateTime } from "../labels.ts";

/**
 * A private link that calendar apps subscribe to, showing the student's due dates and class
 * dates. The link is shown once, when it is made: the school keeps only a fingerprint of it.
 * Replacing it stops the old link working; turning it off stops it altogether.
 */
export const CalendarSubscription = ({ origin }: { origin: string }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [status, reload] = useQuery("calendar-feed", (client) => client.call("me.calendarFeed"));
  const [link, setLink] = useState<string | undefined>(undefined);
  const [action, setAction] = useState<{ running: "make" | "off" } | { failed: unknown } | undefined>(undefined);

  const make = async () => {
    setAction({ running: "make" });
    try {
      const { path } = await api.call("me.rotateCalendarFeed");
      setLink(new URL(path, origin).href);
      setAction(undefined);
      announce("New calendar link made. Earlier links no longer work.");
      reload();
    } catch (failed) {
      setAction({ failed });
    }
  };
  const turnOff = async () => {
    setAction({ running: "off" });
    try {
      await api.call("me.revokeCalendarFeed");
      setLink(undefined);
      setAction(undefined);
      announce("Calendar link turned off");
      reload();
    } catch (failed) {
      setAction({ failed });
    }
  };

  if (status.status === "loading") return null;
  if (status.status === "error") return <ErrorState error={status.error} title="We couldn't check your calendar link" onRetry={reload} />;
  const active = status.data.active;
  const running = action !== undefined && "running" in action ? action.running : undefined;
  return (
    <div className="flex flex-col gap-3">
      <Text variant="secondary">
        Add your due dates to a calendar app such as Google Calendar or Apple Calendar. It shows titles and dates only, never grades or feedback.
      </Text>
      {link !== undefined ? (
        <div className="flex flex-col gap-2">
          <Input label="Your calendar link" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
          <Banner variant="secondary" icon={<WarningIcon weight="fill" />} title="Copy it now: it won't be shown again" description="Anyone with this link can see your due dates. If you share it by mistake, replace it." />
        </div>
      ) : active && status.data.createdAt !== undefined ? (
        <Text>{`Your calendar link was made ${formatDateTime(status.data.createdAt)}.`}</Text>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant={active ? "secondary" : "primary"} loading={running === "make"} disabled={running !== undefined} onClick={() => void make()}>
          {active ? "Replace link" : "Make a calendar link"}
        </Button>
        {active ? (
          <Button variant="secondary" loading={running === "off"} disabled={running !== undefined} onClick={() => void turnOff()}>Turn off link</Button>
        ) : null}
      </div>
      {action !== undefined && "failed" in action ? <ErrorState error={action.failed} title="We couldn't change your calendar link" /> : null}
    </div>
  );
};
