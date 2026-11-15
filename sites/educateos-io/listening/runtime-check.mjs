// Real workerd/SQLite storage smoke. No network calls or production bindings.
// First bundle: pnpm exec wrangler deploy -c sites/educateos-io/wrangler.jsonc --dry-run --outdir /tmp/educateos-listening-worker
// Then: node sites/educateos-io/listening/runtime-check.mjs /tmp/educateos-listening-worker/worker.js
import assert from 'node:assert/strict';
import {mkdtemp, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {createRequire} from 'node:module';
const rootRequire = createRequire(new URL('../../../package.json', import.meta.url));
const {Miniflare, convertV4MiniflareOptions} = createRequire(rootRequire.resolve('wrangler'))('miniflare');
const scriptPath = resolve(process.argv[2]);
const persist = await mkdtemp(join(tmpdir(), 'educateos-listening-sqlite-'));
const secret = 'fixture-export-token-for-local-test-only'.repeat(2);
const textModules = (await readdir(dirname(scriptPath))).filter(name => name.endsWith('.html')).map(name => ({type: 'Text', path: join(dirname(scriptPath), name)}));
const options = {name: 'listening-runtime-test', modulesRoot: dirname(scriptPath), modules: [{type: 'ESModule', path: scriptPath}, ...textModules], compatibilityDate: '2026-10-01',
  durableObjects: {INTEREST: {className: 'InterestIntake', useSQLite: true}}, resourcePersistencePath: persist,
  bindings: {LISTENING_ENABLED: 'false', LISTENING_EXPORT_TOKEN: secret, LISTENING_HMAC_SECRET: 'fixture-hmac-token-for-local-test-only'.repeat(2)},
};
let mf;
try {
  mf = new Miniflare(convertV4MiniflareOptions(options));
  let namespace = await mf.getDurableObjectNamespace('INTEREST');
  let object = namespace.get(namespace.idFromName('community-listening-v1-survey'));
  const input = {now: Date.now(), record: {kind: 'survey', tools: ['MagicSchool']}, address: 'fixture-hashed-receipt',
    idem: 'fixture-idempotency', fingerprint: 'fixture-fingerprint', tokenHash: 'fixture-token-hash'};
  const response = await object.fetch('https://intake.internal/submit', {method: 'POST', body: JSON.stringify(input)});
  assert.equal((await response.json()).status, 200);
  await mf.dispose();
  // A fresh workerd process uses the same on-disk SQLite state.
  mf = new Miniflare(convertV4MiniflareOptions(options));
  const exported = await mf.dispatchFetch('https://educateos.io/api/listening/admin/export?kind=survey', {headers: {authorization: 'Bearer ' + secret}});
  assert.equal(exported.status, 200); const body = await exported.json();
  assert.equal(body.records.length, 1); assert.deepEqual(body.records[0].tools, ['MagicSchool']);
  const denied = await mf.dispatchFetch('https://educateos.io/api/listening/admin/export?kind=survey'); assert.equal(denied.status, 401);
  const closed = await mf.dispatchFetch('https://educateos.io/api/listening/config'); assert.equal(closed.status, 503);
  namespace = await mf.getDurableObjectNamespace('INTEREST');
  object = namespace.get(namespace.idFromName('community-listening-v1-survey'));
  const duplicate = await object.fetch('https://intake.internal/submit', {method: 'POST', body: JSON.stringify(input)});
  assert.equal((await duplicate.json()).status, 200);
  await object.fetch('https://intake.internal/privacy', {method: 'POST', body: JSON.stringify({now: Date.now(), address: input.address, erase: true})});
  const after = await mf.dispatchFetch('https://educateos.io/api/listening/admin/export?kind=survey', {headers: {authorization: 'Bearer ' + secret}});
  assert.equal((await after.json()).records.length, 0);
  console.log('PASS: real workerd SQLite survives process restart, retry stays idempotent, staff export is protected, erasure works, collection is closed.');
} finally {
  await mf?.dispose(); await rm(persist, {recursive: true, force: true});
}
