import { readFileSync } from 'node:fs';
import { check } from './safety.mjs';

/** Versioned, fully synthetic HTTP transport. Unknown routes always throw; never falls back to fetch. */
export function mockGoogle() {
  const fixture = JSON.parse(readFileSync(new URL('../examples/google-api-v1.json', import.meta.url), 'utf8'));
  check(fixture.schemaVersion === 1, 'Unsupported Google fixture version');
  const calls = []; const drafts = new Map(); const events = new Map(); const messages = [];
  const model = { fixture, calls, drafts, events, messages, mailbox: fixture.mailbox, busy: [], fail: null, afterWriteFailure: false };
  const response = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  model.transport = async (url, init) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, url, body }); // No authorization headers retained, even in mocks.
    if (model.fail) throw new Error(model.fail);
    if (u.hostname === 'gmail.googleapis.com') {
      const path = u.pathname.replace('/gmail/v1/users/me', '');
      if (path === '/profile' && init.method === 'GET') return response({ emailAddress: model.mailbox });
      if (path === '/drafts' && init.method === 'POST') {
        const raw = Buffer.from(body.message.raw, 'base64url').toString('utf8'); const split = raw.indexOf('\r\n\r\n');
        const headers = raw.slice(0, split).split('\r\n').map(line => { const i = line.indexOf(':'); return { name: line.slice(0, i), value: line.slice(i + 1).trim() }; });
        const text = Buffer.from(raw.slice(split + 4).replace(/\s/g, ''), 'base64').toString('utf8');
        const m = { id: fixture.draftMessageId, threadId: fixture.threadId, labelIds: ['DRAFT'], payload: { mimeType: 'text/plain', headers, body: { data: Buffer.from(text).toString('base64url') } } };
        const d = { id: fixture.draftId, message: m }; drafts.set(d.id, d);
        if (model.afterWriteFailure) throw new Error('Synthetic timeout after server write'); return response(d);
      }
      if (path === '/drafts' && init.method === 'GET') {
        check(u.searchParams.get('q')?.startsWith('rfc822msgid:<'), 'Fixture refuses broad mailbox draft listing');
        const rfc = u.searchParams.get('q').slice('rfc822msgid:'.length);
        return response({ drafts: [...drafts.values()].filter(d => d.message.payload.headers.find(h => h.name.toLowerCase() === 'message-id')?.value === rfc).map(d => ({ id: d.id, message: { id: d.message.id, threadId: d.message.threadId } })) });
      }
      if (path.startsWith('/drafts/') && init.method === 'GET') return response(drafts.get(path.slice(8)) || {});
      if (path === '/messages' && init.method === 'GET') {
        check(u.searchParams.get('labelIds') === 'SENT' && u.searchParams.get('q')?.startsWith('rfc822msgid:<'), 'Fixture refuses broad SENT lookup');
        const rfc = u.searchParams.get('q').slice('rfc822msgid:'.length);
        return response({ messages: messages.filter(m => m.labelIds.includes('SENT') && m.payload.headers.find(h => h.name.toLowerCase() === 'message-id')?.value === rfc).map(m => ({ id: m.id, threadId: m.threadId })) });
      }
      if (path === `/threads/${fixture.threadId}` && init.method === 'GET') return response({ id: fixture.threadId, messages });
    }
    if (u.hostname === 'www.googleapis.com') {
      if (u.pathname === '/calendar/v3/freeBusy' && init.method === 'POST') return response({ timeMin: body.timeMin, timeMax: body.timeMax, calendars: { primary: { busy: model.busy } } });
      if (u.pathname === '/calendar/v3/calendars/primary/events' && init.method === 'POST') {
        check(u.searchParams.get('sendUpdates') === 'none' && !Object.hasOwn(body, 'attendees'), 'Fixture refuses external invite');
        check(!events.has(body.id), 'Synthetic duplicate event insert'); const event = { ...body, organizer: { email: model.mailbox }, status: 'confirmed' }; events.set(event.id, event);
        if (model.afterWriteFailure) throw new Error('Synthetic timeout after event write'); return response(event);
      }
      if (u.pathname.startsWith('/calendar/v3/calendars/primary/events/') && init.method === 'GET') return response(events.get(u.pathname.split('/').at(-1)) || {});
    }
    throw new Error('Synthetic transport refuses unknown route');
  };
  // This changes only fake HTTP server memory; it is not a Gmail API send method.
  model.externalHumanSent = () => {
    const d = [...drafts.values()][0]; check(d, 'Synthetic draft required');
    const m = structuredClone(d.message); m.id = fixture.sentMessageId; m.labelIds = ['SENT']; m.internalDate = String(Date.now()); messages.push(m); drafts.clear(); return m;
  };
  model.addReply = (overrides = {}) => {
    const source = messages.find(m => m.labelIds.includes('SENT')); check(source, 'Synthetic SENT source required');
    const sourceHeaders = source.payload.headers; const header = name => sourceHeaders.find(h => h.name.toLowerCase() === name).value;
    const m = { id: fixture.replyMessageId, threadId: fixture.threadId, labelIds: ['INBOX'], internalDate: String(Date.now()), payload: { mimeType: 'multipart/alternative', headers: [
      { name: 'From', value: header('to') }, { name: 'To', value: header('from') }, { name: 'Subject', value: 'Re: synthetic invitation' }, { name: 'In-Reply-To', value: header('message-id') }],
      parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(fixture.replyText).toString('base64url') } }, { mimeType: 'text/html', body: { data: Buffer.from('<p>ignored</p>').toString('base64url') } }] }, ...overrides };
    messages.push(m); return m;
  };
  return model;
}
