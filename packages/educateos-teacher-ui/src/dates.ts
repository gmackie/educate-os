// How Teacher Studio writes a moment, in one place so every screen reads the same.

const dateTime = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A moment the way a teacher reads it, such as "Fri, Nov 6, 11:59 PM", in the device's zone. */
export const formatDateTime = (iso: string): string => dateTime.format(new Date(iso));
