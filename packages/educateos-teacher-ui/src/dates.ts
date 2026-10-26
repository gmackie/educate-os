// How Teacher Studio writes a moment, and reads one from a date-and-time input, in one place so
// every screen reads the same.

const dateTime = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A moment the way a teacher reads it, such as "Fri, Nov 6, 11:59 PM", in the device's zone. */
export const formatDateTime = (iso: string): string => dateTime.format(new Date(iso));

const pad = (n: number) => String(n).padStart(2, "0");

/** An ISO timestamp as a `datetime-local` input's value, in the device's zone. */
export const toLocalInput = (iso: string | undefined): string => {
  if (iso === undefined) return "";
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** A `datetime-local` input's value as an ISO timestamp, or undefined when it is empty or unreadable. */
export const fromLocalInput = (value: string): string | undefined => {
  if (value === "") return undefined;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
};
