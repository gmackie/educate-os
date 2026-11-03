// When the demo districts' work falls due: on a school day, at a time a teacher would set.

/**
 * When an activity due `days` from `today` falls due: that school day at 3:30 PM in the visitor's
 * own time zone, a weekend moved to the Monday after, as an ISO date-time (UTC).
 */
export const schoolDayDue = (today: Date) => (days: number): string => {
  const due = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days, 15, 30);
  const weekday = due.getDay();
  if (weekday === 6) due.setDate(due.getDate() + 2);
  if (weekday === 0) due.setDate(due.getDate() + 1);
  return due.toISOString();
};
