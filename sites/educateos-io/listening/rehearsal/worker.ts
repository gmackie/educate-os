// SCHO-430: deploy only with this directory's isolated config, never the site's config.
import {DurableObject} from 'cloudflare:workers';
import {InterestIntake} from '../../intake/worker.ts';
import {authorized, reply, RETENTION_MS} from '../../intake/core.mjs';

const PREFIX = '/rehearsal/';
const OBJECTS = new Set(['retention', 'recovery']);
const ACTIONS = new Set(['seed', 'inspect', 'bookmark', 'erase', 'restore', 'restart', 'clean']);
const ADDRESS = 'synthetic-rehearsal-receipt';
const INPUT = {record: {kind: 'survey', tools: ['MagicSchool']}, address: ADDRESS,
  idem: 'synthetic-retry', fingerprint: 'synthetic-fingerprint', tokenHash: 'synthetic-challenge'};

/** Private, synthetic-only SQLite rehearsal; has no production namespace binding. */
export class RehearsalIntake extends DurableObject {
  private readonly intake: InterestIntake;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.intake = new InterestIntake(ctx, env);
  }

  async alarm(): Promise<void> {
    await this.intake.alarm();
    await this.ctx.storage.put('rehearsal:alarm', true);
  }

  async fetch(request: Request): Promise<Response> {
    const [kind, action] = new URL(request.url).pathname.slice(PREFIX.length).split('/');
    const call = async (name: string, data: Record<string, unknown>) => {
      const response = await this.intake.fetch(new Request('https://intake.internal/' + name,
        {method: 'POST', body: JSON.stringify(data)}));
      return response.json() as Promise<{status?: number; records?: unknown[]}>;
    };
    if (action === 'clean') {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return reply(200);
    }
    if (action === 'seed') {
      // Accelerate only this fixed synthetic row's clock. Production TTL stays 90 days.
      const now = Date.now() - (kind === 'retention' ? RETENTION_MS - 5000 : 0);
      const first = await call('submit', {...INPUT, now});
      const retry = await call('submit', {...INPUT, now});
      if (kind === 'retention') await this.ctx.storage.setAlarm(Date.now() + 6000);
      return reply(200, {first: first.status, retry: retry.status});
    }
    if (action === 'inspect') {
      const exported = await call('export', {now: Date.now()});
      return reply(200, {exported: exported.records?.length,
        stored: (await this.ctx.storage.list({prefix: 'record:', limit: 2})).size,
        alarmDelivered: await this.ctx.storage.get('rehearsal:alarm') === true,
        suppressed: await this.ctx.storage.get('suppressed:' + ADDRESS) === true});
    }
    if (action === 'erase') {
      await call('privacy', {now: Date.now(), address: ADDRESS, erase: true});
      return reply(200);
    }
    if (action === 'bookmark') {
      await this.ctx.storage.sync();
      return reply(200, {bookmark: await this.ctx.storage.getCurrentBookmark()});
    }
    if (action === 'restore') {
      const bookmark = await request.text();
      if (!/^[0-9a-f-]{20,150}$/i.test(bookmark)) return reply(400);
      await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
    }
    if (action === 'restore' || action === 'restart') {
      await this.ctx.storage.sync();
      setTimeout(() => { try { this.ctx.abort('synthetic listening rehearsal restart'); } catch {} }, 250);
      return reply(202);
    }
    return reply(404);
  }
}

export default {
  async fetch(request: Request, env: {REHEARSAL: DurableObjectNamespace; REHEARSAL_TOKEN?: string;
    REHEARSAL_UNTIL?: string; FG_COMMIT_HASH?: string}): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return reply(200, {status: 'ok', revision: env.FG_COMMIT_HASH});
    }
    // Finite lifetime, bearer only, no CORS. No public test bypass or arbitrary dispatch.
    if (!await authorized(request, env.REHEARSAL_TOKEN)) return reply(401);
    if (!(Date.parse(env.REHEARSAL_UNTIL ?? '') > Date.now())) return reply(410);
    const parts = url.pathname.slice(PREFIX.length).split('/');
    if (!url.pathname.startsWith(PREFIX) || parts.length !== 2 || !OBJECTS.has(parts[0]) ||
        !ACTIONS.has(parts[1]) || request.method !== 'POST' || url.search) return reply(404);
    // All commands have no body except a short provider bookmark. Bound the stream as well.
    const reader = request.body?.getReader();
    let body = '';
    if (reader) {
      let bytes = 0;
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 200) { await reader.cancel(); return reply(413); }
        body += decoder.decode(chunk.value, {stream: true});
      }
      body += decoder.decode();
    }
    if (parts[1] !== 'restore' && body) return reply(400);
    const object = env.REHEARSAL.get(env.REHEARSAL.idFromName('listening-synthetic-' + parts[0]));
    return object.fetch(new Request(url, {method: 'POST', body}));
  },
};
