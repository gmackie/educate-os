// Local workerd checks. Provider PITR is deliberately tested only after isolated deployment.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const {Miniflare, convertV4MiniflareOptions} = createRequire(require.resolve('wrangler'))('miniflare');
const token = 'synthetic-local-rehearsal-only-credential'.repeat(2);
const mf = new Miniflare(convertV4MiniflareOptions({
  name: 'listening-rehearsal-local', modulesRoot: dirname(resolve(process.argv[2])),
  modules: [{type: 'ESModule', path: resolve(process.argv[2])}], compatibilityDate: '2026-10-01',
  durableObjects: {REHEARSAL: {className: 'RehearsalIntake', useSQLite: true}},
  bindings: {REHEARSAL_TOKEN: token, REHEARSAL_UNTIL: '2099-01-01T00:00:00Z'},
}));
const call = (path, body = '', auth = token) => mf.dispatchFetch('https://rehearsal.invalid' + path,
  {method: 'POST', headers: {authorization: 'Bearer ' + auth}, body});
try {
  assert.equal((await call('/rehearsal/recovery/seed', '', 'wrong')).status, 401);
  assert.equal((await call('/rehearsal/production/seed')).status, 404);
  assert.equal((await call('/rehearsal/recovery/arbitrary')).status, 404);
  assert.equal((await call('/rehearsal/recovery/restore', 'x'.repeat(201))).status, 413);
  assert.equal((await call('/rehearsal/recovery/restore', 'bad')).status, 400);
  assert.deepEqual(await (await call('/rehearsal/recovery/seed')).json(), {first: 200, retry: 200});
  assert.equal((await (await call('/rehearsal/recovery/inspect')).json()).exported, 1);
  assert.equal((await call('/rehearsal/recovery/restart')).status, 202);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await (await call('/rehearsal/recovery/inspect')).json()).stored, 1);
  await call('/rehearsal/recovery/erase');
  const erased = await (await call('/rehearsal/recovery/inspect')).json();
  assert.equal(erased.stored, 0); assert.equal(erased.exported, 0); assert.equal(erased.suppressed, true);
  await call('/rehearsal/retention/seed');
  await new Promise(resolve => setTimeout(resolve, 7500));
  const expired = await (await call('/rehearsal/retention/inspect')).json();
  assert.equal(expired.stored, 0); assert.equal(expired.exported, 0); assert.equal(expired.alarmDelivered, true);
  for (const kind of ['retention', 'recovery']) await call('/rehearsal/' + kind + '/clean');
  console.log('PASS: isolated authentication, dispatch/body bounds, SQLite restart, idempotency, erasure and expiry alarm; provider restore remains a deployed check.');
} finally { await mf.dispose(); }
