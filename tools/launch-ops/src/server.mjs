import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { check } from './safety.mjs';
import { mutations, snapshot, rankContacts, previewGate, exportInvitations, exportPilot, exportTicket } from './domain.mjs';

const assets = new Map([
  ['/', ['text/html; charset=utf-8', readFileSync(new URL('../web/index.html', import.meta.url))]],
  ['/app.js', ['text/javascript; charset=utf-8', readFileSync(new URL('../web/app.js', import.meta.url))]],
  ['/style.css', ['text/css; charset=utf-8', readFileSync(new URL('../web/style.css', import.meta.url))]],
]);
const exportsByAction = { 'invitations.export': exportInvitations, 'pilots.export': exportPilot, 'tickets.export': exportTicket };
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; check(size <= 250_000, 'Request exceeds 250 KB'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object'); return value;
}
export function createDashboard(store) {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const host = `127.0.0.1:${server.address().port}`;
      check(req.headers.host === host, 'Invalid Host');
      check(!req.headers.origin || req.headers.origin === `http://${host}`, 'Cross-origin request denied');
      check(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']), 'Cross-site request denied');
      if (req.method === 'GET' && assets.has(req.url)) {
        const [type, content] = assets.get(req.url); res.writeHead(200, { 'Content-Type': type }); res.end(content); return;
      }
      const provided = req.headers['x-launch-ops-token'];
      check(typeof provided === 'string' && provided.length === token.length && timingSafeEqual(Buffer.from(provided), Buffer.from(token)), 'Local session token required');
      if (req.method === 'GET' && req.url === '/api/state') { json(200, snapshot(store.read())); return; }
      check(req.method === 'POST' && req.url === '/api/command', 'Unknown route or method');
      check(req.headers['content-type'] === 'application/json', 'Use application/json');
      const input = await body(req);
      const { action, data = {} } = input;
      check(data !== null && typeof data === 'object' && !Array.isArray(data), 'Invalid command data');
      let result;
      if (action === 'contacts.rank') result = rankContacts(store.read(), data.council);
      else if (action === 'gates.preview') result = previewGate(store.read(), data);
      else if (action === 'evidence.read') {
        const e = store.read().evidence.find(e => e.id === data.id); check(e, 'Evidence not found'); result = e;
      } else if (Object.hasOwn(exportsByAction, action)) {
        result = store.transaction(state => {
          const content = exportsByAction[action](state, data);
          const format = action === 'invitations.export' ? data.format : 'json';
          const file = store.exportFile(content, format);
          return { name: file.name, location: '.private/exports/', content };
        });
      } else {
        check(Object.hasOwn(mutations, action), 'Unknown action; no send or external-email action exists');
        result = store.transaction(state => mutations[action](state, data));
      }
      json(200, { result });
    } catch (error) {
      // Do not log requests, bodies, contact data, evidence or tokens.
      json(400, { error: error instanceof SyntaxError ? 'Invalid JSON' : error.message });
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 40;
  return { server, token };
}
