import { createHash, randomUUID } from 'node:crypto';

export function check(condition, message) {
  if (!condition) throw new Error(message);
}
export function text(value, label, max = 2000) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `Invalid ${label}`);
  // oxlint-disable-next-line no-control-regex -- Reject unsafe control bytes in operator input.
  check(!/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value), `Unsafe controls in ${label}`);
  return value.trim();
}
export function oneOf(value, options, label) {
  check(options.includes(value), `Invalid ${label}`);
  return value;
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).toSorted().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function sourceUrl(value) {
  const u = new URL(text(value, 'public source URL', 1000));
  check(u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash, 'Use a public HTTPS source URL without credentials, query or fragment');
  check(!/^(localhost|.*\.local|.*\.internal|\[.*\]|[\d.]+)$/i.test(u.hostname), 'Source must be a public hostname');
  return u.href.replace(/\/$/, '');
}
export function email(value) {
  const v = text(value, 'professional email', 254).toLowerCase();
  check(/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(v), 'Invalid professional email');
  check(!/[@](gmail|yahoo|hotmail|outlook|icloud|aol)\./i.test(v), 'Use a publicly listed organizational address');
  return v;
}
export function noSensitive(value) {
  check(!/\b(?:\d{3}-\d{2}-\d{4}|student\s*(?:name|id|record)\s*[:=]|(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+|sk-[a-z0-9]{12,}|\bBearer\s+\S+)/i.test(value), 'Remove student information or secrets before entry');
  return value;
}
export function human(input, expectedHash) {
  check(input.humanReviewed === true, 'Explicit human review is required');
  check(input.reviewedHash === expectedHash, 'Content changed; review the current hash');
  return text(input.reviewer, 'human reviewer', 120);
}
export function csvCell(value) {
  let s = String(value ?? '');
  // Spreadsheets may skip whitespace/control/format characters before a formula.
  // oxlint-disable-next-line no-control-regex -- Spreadsheets skip controls before formulas.
  if (/^[\s\p{Cf}\x00-\x1f]*[=+@-]/u.test(s) || /^[\t\r\n]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}
export function toCsv(rows) {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
export function parseCsv(raw) {
  check(typeof raw === 'string' && Buffer.byteLength(raw) <= 200_000, 'CSV exceeds 200 KB');
  const rows = []; let row = []; let cell = ''; let quoted = false; let closed = false;
  raw = raw.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) {
      if (c === '"' && raw[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"' && cell === '' && !closed) quoted = true;
    else if (c === ',' || c === '\n') {
      row.push(cell); cell = ''; closed = false;
      if (c === '\n') { rows.push(row); row = []; }
    } else { check(!closed && c !== '"' && c !== '\r', 'Malformed CSV'); cell += c; }
  }
  check(!quoted, 'Unterminated CSV quote');
  if (cell || row.length || closed) { row.push(cell); rows.push(row); }
  check(rows.length >= 2 && rows.length <= 501, 'CSV needs a header and 1–500 contacts');
  const headers = rows.shift();
  check(new Set(headers).size === headers.length, 'Duplicate CSV headers');
  const required = ['name', 'email', 'organization', 'role', 'sourceUrl', 'tags'];
  check(headers.length === required.length && required.every(h => headers.includes(h)), 'CSV headers: name,email,organization,role,sourceUrl,tags');
  return rows.map(r => {
    check(r.length === headers.length, 'CSV row width mismatch');
    return Object.fromEntries(headers.map((h, i) => [h, h === 'tags' ? r[i].split('|').filter(Boolean) : r[i]]));
  });
}
export function redact(raw) {
  text(raw, 'support text', 12_000);
  return raw
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED KEY]')
    .replace(/\b(?:Bearer\s+\S+|sk-[a-z0-9_-]{8,})/gi, '[REDACTED SECRET]')
    .replace(/\b(?:password|secret|token|api[_ -]?key)\s*[:=]\s*\S+/gi, '[REDACTED SECRET]')
    .replace(/https?:\/\/[^\s<>]+/gi, '[REDACTED URL]')
    .replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[a-z]{2,}/gi, '[REDACTED EMAIL]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED ID]')
    .replace(/\b(?:\+?\d[\d ().-]{6,}\d)\b/g, '[REDACTED NUMBER]')
    .replace(/\b(?:student|pupil|child)\s*(?:name|id|record)?\s*[:=]\s*[^\n;]+/gi, '[REDACTED STUDENT FIELD]');
}
