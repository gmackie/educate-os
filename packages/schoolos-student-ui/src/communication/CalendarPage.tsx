import { useState } from "react";
import { Button, Empty, Link, Surface, Text } from "@cloudflare/kumo";
import { CalendarBlankIcon, CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import type { CalendarEvent } from "../model.ts";
import { activityPath, coursePath } from "../router.tsx";
import { addDays, byDay, dateOfKey, dayKey, startOfWeek } from "./calendarDays.ts";

type View = "week" | "agenda";

/** How far ahead the agenda looks, in days. */
const AGENDA_DAYS = 56;

const dayHeading = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const timeOfDay = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const EventRow = ({ event }: { event: CalendarEvent }) => {
  const href = event.offeringId === undefined ? undefined : event.assignmentId === undefined ? coursePath(event.offeringId) : activityPath(event.offeringId, event.assignmentId);
  return (
    <li className="flex gap-3">
      <Text variant="secondary" size="sm">
        {event.allDay ? "All day" : <time dateTime={event.start}>{timeOfDay.format(new Date(event.start))}</time>}
      </Text>
      {href === undefined ? <Text>{event.title}</Text> : <Link href={href}>{event.title}</Link>}
    </li>
  );
};

const Day = ({ day, events }: { day: string; events: readonly CalendarEvent[] }) => (
  <Surface as="section" aria-labelledby={`day-${day}`} className="flex flex-col gap-2 rounded-lg border border-kumo-hairline p-3">
    <Text variant="heading" as="h2"><span id={`day-${day}`}>{dayHeading.format(dateOfKey(day))}</span></Text>
    {events.length === 0 ? <Text variant="secondary" size="sm">Nothing scheduled</Text> : <ul className="flex flex-col gap-1">{events.map((e) => <EventRow key={e.uid} event={e} />)}</ul>}
  </Surface>
);

/**
 * The student's calendar: due dates, announcements and term dates from their classes, as a week
 * of days or as an agenda of the weeks ahead. Each day is a headed section, so a screen reader can
 * move day by day.
 */
export const CalendarPage = ({ today = new Date() }: { today?: Date }) => {
  const [view, setView] = useState<View>("week");
  const [weekStart, setWeekStart] = useState(() => startOfWeek(today));
  const from = view === "week" ? weekStart : new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const to = addDays(from, view === "week" ? 7 : AGENDA_DAYS);
  const [calendar, reload] = useQuery(`calendar:${from.toISOString()}:${to.toISOString()}`, (api) =>
    api.call("me.calendar", { query: { from: from.toISOString(), to: to.toISOString() } }));

  const days = calendar.status === "ready" ? byDay(calendar.data.events) : new Map<string, CalendarEvent[]>();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Text variant="heading" size="lg" as="h1">Calendar</Text>
        <div role="group" aria-label="Calendar view" className="flex gap-2">
          <Button variant={view === "week" ? "primary" : "secondary"} aria-pressed={view === "week"} onClick={() => setView("week")}>Week</Button>
          <Button variant={view === "agenda" ? "primary" : "secondary"} aria-pressed={view === "agenda"} onClick={() => setView("agenda")}>Agenda</Button>
        </div>
      </div>
      {view === "week" ? (
        <nav aria-label="Weeks" className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" icon={<CaretLeftIcon aria-hidden />} onClick={() => setWeekStart(addDays(weekStart, -7))}>Previous week</Button>
          <Button variant="secondary" onClick={() => setWeekStart(startOfWeek(today))}>This week</Button>
          <Button variant="secondary" icon={<CaretRightIcon aria-hidden />} onClick={() => setWeekStart(addDays(weekStart, 7))}>Next week</Button>
          <Text variant="secondary" aria-live="polite">{`Week of ${dayHeading.format(weekStart)}`}</Text>
        </nav>
      ) : null}
      {calendar.status === "loading" ? <LoadingSkeleton label="Loading your calendar" lines={4} /> : null}
      {calendar.status === "error" ? <ErrorState error={calendar.error} title="We couldn't load your calendar" onRetry={reload} /> : null}
      {calendar.status === "ready" && view === "week" ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 7 }, (_, i) => dayKey(addDays(weekStart, i))).map((day) => <Day key={day} day={day} events={days.get(day) ?? []} />)}
        </div>
      ) : null}
      {calendar.status === "ready" && view === "agenda" ? (
        days.size === 0 ? (
          <Empty size="sm" icon={<CalendarBlankIcon aria-hidden size={32} />} title="Nothing coming up" description="Due dates and announcements from your classes show up here." />
        ) : (
          <div className="flex flex-col gap-3">{[...days].map(([day, events]) => <Day key={day} day={day} events={events} />)}</div>
        )
      ) : null}
    </div>
  );
};
