import { check, hash, redact } from './safety.mjs';

export function decodeBase64url(value) {
  check(typeof value === 'string' && value.length <= 64_000 && /^[a-zA-Z0-9_-]*={0,2}$/.test(value) && value.replace(/=+$/, '').length % 4 !== 1, 'Unsupported MIME encoding or size');
  const bytes = Buffer.from(value, 'base64url');
  check(bytes.toString('base64url') === value.replace(/=+$/, ''), 'Malformed base64url');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export function decodeHeader(value) {
  check(typeof value === 'string' && value.length <= 2000 && !/[\r\n]/.test(value), 'Invalid message header');
  const decoded = value.replace(/\?=\s+=\?/g, '?==?').replace(/=\?UTF-8\?([BQ])\?([^?]+)\?=/gi, (_, encoding, data) => {
    if (encoding.toUpperCase() === 'B') return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(data, 'base64'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'binary'));
  });
  check(!decoded.includes('=?') && !/[\r\n]/.test(decoded), 'Unsupported encoded header'); return decoded;
}
export function headers(payload) {
  check(Array.isArray(payload?.headers) && payload.headers.length <= 100, 'Message headers required');
  const out = {};
  for (const h of payload.headers) {
    check(typeof h.name === 'string' && typeof h.value === 'string', 'Invalid message headers'); const name = h.name.toLowerCase();
    check(!Object.hasOwn(out, name), 'Duplicate message header requires manual review'); out[name] = decodeHeader(h.value);
  }
  return out;
}
export function mailbox(value) {
  check(typeof value === 'string' && !/[,;\r\n]/.test(value), 'One exact mailbox required');
  const match = /^(?:[^<>]*<)?([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})>?$/i.exec(value.trim());
  check(match, 'Unsupported mailbox header'); return match[1].toLowerCase();
}
/** Gmail full-format body.data is already MIME-transfer decoded, then base64url encoded. */
export function plainText(payload) {
  let nodes = 0; const parts = [];
  function visit(p, depth) {
    check(++nodes <= 40 && depth <= 6, 'MIME structure too complex');
    if (p.filename || p.body?.attachmentId) return;
    if (p.mimeType === 'text/plain') {
      const type = p.headers?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
      check(!/charset=/i.test(type) || /charset=["']?utf-8\b/i.test(type) || /charset=["']?us-ascii\b/i.test(type), 'Unsupported text charset');
      parts.push(decodeBase64url(p.body?.data));
    } else if (p.mimeType?.startsWith('multipart/')) { check(Array.isArray(p.parts), 'Missing MIME parts'); p.parts.forEach(x => visit(x, depth + 1)); }
  }
  visit(payload, 0); check(parts.length === 1, 'Exactly one narrow text/plain part required');
  check(parts[0].length <= 32_000, 'Message text too large'); return parts[0];
}
export const normalizeBody = value => value.replace(/\r\n/g, '\n').replace(/\n$/, '');
export const copyHash = copy => hash({ from: copy.from.toLowerCase(), to: copy.to.toLowerCase(), subject: copy.subject, body: normalizeBody(copy.body) });
export function messageCopy(message) {
  const h = headers(message.payload);
  check(!h.cc && !h.bcc, 'Additional recipients require manual review');
  return { from: mailbox(h.from), to: mailbox(h.to), subject: h.subject, body: plainText(message.payload), rfcId: h['message-id'], headers: h };
}
export function replyText(raw) {
  const text = raw.replace(/\r\n/g, '\n').split('\n').filter(line => !/^\s*>/.test(line)).join('\n').split(/\n(?:-- ?(?:\n|$)|Sent from my .{1,100}(?:\n|$)|On .{1,300}wrote:|[- ]*Original Message[- ]*|From:)/i)[0].trim();
  check(text.length > 0 && text.length <= 4000, 'Reply requires manual review of unsupported or long text');
  // Opt-out is detected before redaction, never by an LLM or a positive-keyword classifier.
  const optout = /(?:^|\n)\s*(?:STOP[.!]?|unsubscribe[.!]?|please (?:unsubscribe|remove) me(?: from (?:your|the) (?:mailing )?list)?[.!]?)\s*(?:$|\n)/i.test(text);
  return { text: redact(text), optout };
}
