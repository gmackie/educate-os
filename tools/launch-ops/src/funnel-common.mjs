import { check, noSensitive, text } from './safety.mjs';

export const safe = (v, label, max = 2000) => noSensitive(text(v, label, max));
export const get = (s, collection, key) => { const v = s[collection].find(x => x.id === key); check(v, `${collection} record not found`); return v; };
export const norm = v => v.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
export const single = (v, label, max = 240) => { const out = safe(v, label, max); check(!/[\r\n]/.test(out), `${label} must be one line`); return out; };
export function timestamp(v) {
  check(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v) && Number.isFinite(Date.parse(v)), 'Use an ISO UTC timestamp');
  check(Date.parse(v) <= Date.now() + 60_000, 'Future evidence is not accepted');
  return new Date(v).toISOString();
}
export function date(v) {
  check(typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && new Date(v).toISOString().slice(0, 10) === v && v <= new Date().toISOString().slice(0, 10), 'Use an actual observation date, not a future date'); return v;
}
export function exact(v, keys, label) {
  check(v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k)), `Unknown ${label} fields`);
}
export function staffText(v, max = 1500) {
  if (v === '') return '';
  const out = safe(v, 'staff-only text', max);
  check(!/\b(?:student|pupil|child|minor|password|credential|secret|token|bearer|api[ _-]?key)\b|https?:|www\.|[\w.+-]+@[\w.-]+/i.test(out), 'Staff-only text cannot contain student data, contacts, URLs or credentials'); return out;
}
