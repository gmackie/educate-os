/** Due dates as a teacher types them: local `YYYY-MM-DD HH:MM`, no date-picker dependency. */
const pad = (n: number) => String(n).padStart(2, '0');
/** An ISO time as the teacher's local `YYYY-MM-DD HH:MM`. */
export function localInput(iso: string): string {
  const d = new Date(iso);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
/** `YYYY-MM-DD HH:MM` in local time, or null. */
export function parseLocal(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  return d.getMonth() === +m[2]! - 1 && d.getDate() === +m[3]! ? d : null;
}
