import { Badge, Link } from "@cloudflare/kumo";
import { BellIcon } from "@phosphor-icons/react";
import { useRouterState } from "@tanstack/react-router";
import { useQuery } from "../api.tsx";

/**
 * The header's way to the student's notifications, naming how many are unread. The count is read
 * again on every navigation, so it catches up after the student reads them.
 */
export const NotificationsLink = () => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [notifications] = useQuery(`notification-count:${pathname}`, (api) => api.call("me.notifications"));
  const unread = notifications.status === "ready" ? notifications.data.unread : 0;
  return (
    <Link href="/notifications" variant="plain" className="flex items-center gap-1 py-2" aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}>
      <BellIcon aria-hidden size={20} weight={unread > 0 ? "fill" : "regular"} />
      {unread > 0 ? <span aria-hidden><Badge variant="primary">{unread}</Badge></span> : null}
    </Link>
  );
};
