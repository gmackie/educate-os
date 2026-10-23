import { useState } from "react";
import { Badge, Button, Empty, Link, Surface, Text } from "@cloudflare/kumo";
import { BellSimpleIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { formatDateTime } from "../labels.ts";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import type { NotificationView } from "../model.ts";
import { activityPath, coursePath } from "../router.tsx";

/** Where a notification leads: the activity it is about, or else its class. */
const hrefOf = (notification: NotificationView): string =>
  notification.ref.assignmentId === undefined ? coursePath(notification.offeringId) : activityPath(notification.offeringId, notification.ref.assignmentId);

/**
 * The student's notifications, newest first: new announcements and assignments, work due soon,
 * and feedback and grades that were released. Each names what happened and links to it; a score
 * or a comment is read where it lives.
 */
export const NotificationsPage = () => {
  const api = useApi();
  const announce = useAnnounce();
  const [list, reload] = useQuery("notifications", (client) => client.call("me.notifications"));
  const [marking, setMarking] = useState<{ failed: unknown } | "running" | undefined>(undefined);

  if (list.status === "loading") return <LoadingSkeleton label="Loading your notifications" lines={3} />;
  if (list.status === "error") return <ErrorState error={list.error} title="We couldn't load your notifications" onRetry={reload} />;
  const { notifications, unread } = list.data;

  const markRead = async (body: { all: true } | { ids: string[] }, message: string) => {
    setMarking("running");
    try {
      await api.call("me.markNotificationsRead", { body });
      setMarking(undefined);
      announce(message);
      reload();
    } catch (failed) {
      setMarking({ failed });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Text variant="heading" size="lg" as="h1">Notifications</Text>
        {unread > 0 ? (
          <Button variant="secondary" loading={marking === "running"} onClick={() => void markRead({ all: true }, "All notifications marked as read")}>
            Mark all as read
          </Button>
        ) : null}
      </div>
      {typeof marking === "object" ? <ErrorState error={marking.failed} title="We couldn't mark your notifications as read" /> : null}
      {notifications.length === 0 ? (
        <Empty size="sm" icon={<BellSimpleIcon aria-hidden size={32} />} title="No notifications" description="New announcements, assignments and feedback from your classes show up here." />
      ) : (
        <ul className="flex flex-col gap-2">
          {notifications.map((notification) => (
            <li key={notification.id}>
              <Surface className="flex flex-col gap-2 rounded-lg border border-kumo-hairline p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col gap-1">
                  <Link href={hrefOf(notification)} variant="plain">
                    {notification.readAt === undefined ? <span className="sr-only">Unread: </span> : null}
                    {notification.title}
                  </Link>
                  <Text variant="secondary" size="sm">
                    <time dateTime={notification.occurredAt}>{formatDateTime(notification.occurredAt)}</time>
                  </Text>
                </div>
                {notification.readAt === undefined ? (
                  <div className="flex items-center gap-2">
                    <span aria-hidden><Badge variant="primary">New</Badge></span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={marking === "running"}
                      aria-label={`Mark "${notification.title}" as read`}
                      onClick={() => void markRead({ ids: [notification.id] }, "Marked as read")}
                    >
                      Mark read
                    </Button>
                  </div>
                ) : null}
              </Surface>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
