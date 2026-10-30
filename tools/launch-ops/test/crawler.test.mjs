import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { publicIPv4, approvedUrl, robotsAllows, safeGet, officialSiteRecords, crawlOfficial } from '../src/discovery.mjs';
import { baseState, domain, fixtureFile, operator, tempStore } from './funnel-helpers.mjs';

const origin = 'https://cedar-example.invalid';
function transportFixture({ status = 200, type = 'text/html', body = 'OK', encoding, inspect = () => {} } = {}) {
  return (url, options, callback) => {
    inspect(url, options);
    const req = new EventEmitter(); req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = status; res.headers = { 'content-type': type, ...(encoding ? { 'content-encoding': encoding } : {}) };
      res.resume = () => {}; res.destroy = () => {};
      callback(res); res.emit('data', Buffer.from(body)); res.emit('end'); req.emit('close');
    });
    req.destroy = error => { req.emit('error', error); req.emit('close'); }; return req;
  };
}
test('SSRF: IPv4 special ranges, all IPv6 and mixed public/private DNS answers fail before connection', async () => {
  for (const ip of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', '2001:4860:4860::8888']) assert.equal(publicIPv4(ip), false, ip);
  assert.equal(publicIPv4('8.8.8.8'), true);
  let connected = false;
  const transport = () => { connected = true; throw new Error('must not connect'); };
  for (const address of ['127.0.0.1', '169.254.169.254', '::ffff:8.8.8.8']) await assert.rejects(() => safeGet(`${origin}/staff`, origin, async () => [{ address: '8.8.8.8' }, { address }], transport), /SSRF/);
  assert.equal(connected, false);
});
test('DNS is pinned to actual HTTPS connection; hostname TLS SNI preserved, pooling disabled; no second resolve', async () => {
  let resolutions = 0; let connections = 0;
  const resolver = async () => { resolutions++; return [{ address: resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]; };
  const transport = transportFixture({ inspect: (url, options) => {
    connections++; assert.equal(url.hostname, 'cedar-example.invalid'); assert.equal(options.servername, url.hostname); assert.equal(options.agent, false); assert.equal(options.family, 4);
    options.lookup(url.hostname, {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
    options.lookup(url.hostname, { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); });
    assert.equal(options.headers['Accept-Encoding'], 'identity'); assert.ok(!Object.hasOwn(options, 'rejectUnauthorized'));
  } });
  assert.deepEqual(await safeGet(`${origin}/staff`, origin, resolver, transport), { text: 'OK', type: 'text/html' }); assert.equal(resolutions, 1); assert.equal(connections, 1);
});
test('URL boundary refuses alternate ports, credentials, queries, fragments, private literals, auth/member/student and cross-origin targets', () => {
  for (const url of ['http://cedar-example.invalid/staff', `${origin}:8443/staff`, 'https://u:p@cedar-example.invalid/staff', `${origin}/staff?q=1`, `${origin}/staff#x`, 'https://127.0.0.1/staff', 'https://[::1]/staff', 'https://cedar-example.invalid.evil.invalid/staff', `${origin}/login`, `${origin}/members`, `${origin}/student`, `${origin}/%6c%6f%67%69%6e`, 'https://linkedin.com/staff']) assert.throws(() => approvedUrl(url, origin), url);
  assert.equal(approvedUrl(`${origin}/staff`, origin).origin, origin);
});
test('HTTPS transport rejects redirects, non-200, compressed, huge and unexpected content, without following Location', async () => {
  const resolver = async () => [{ address: '8.8.8.8', family: 4 }];
  for (const fixture of [{ status: 302 }, { status: 403 }, { type: 'application/json' }, { encoding: 'gzip' }, { body: 'x'.repeat(256_001) }]) await assert.rejects(() => safeGet(`${origin}/staff`, origin, resolver, transportFixture(fixture)));
});
test('robots matching honors deny, longest allow, wildcards, agent groups, case and crawl-delay; unsupported delay fails closed', () => {
  const robots = 'User-agent: *\nDisallow: /\nAllow: /staff\nDisallow: /staff/private*\nCrawl-delay: 2\nUser-agent: EducateOSLaunchOps\nDisallow: /staff/blocked$\n';
  assert.equal(robotsAllows(robots, '/staff/avery').allowed, true); assert.equal(robotsAllows(robots, '/staff/avery').waitSeconds, 2);
  for (const path of ['/anything', '/staff/private-person', '/staff/blocked']) assert.equal(robotsAllows(robots, path).allowed, false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /Staff', '/Staff').allowed, false);
  assert.throws(() => robotsAllows('User-agent: *\nCrawl-delay: 90', '/staff'), /Unsupported/);
});
test('official adapter extracts only explicit Person + exact institutional worksFor; no guessed addresses or student rows', () => {
  const org = baseState().organizations[0]; const html = fixtureFile('official-staff.html');
  assert.equal(officialSiteRecords(html, `${origin}/staff`, org).length, 1);
  assert.equal(officialSiteRecords(html.replace('"Person"', '"Student"'), `${origin}/staff`, org).length, 0);
  assert.equal(officialSiteRecords(html.replace('"worksFor":{"@type":"Organization","name":"Cedar Example District"}', '"worksFor":{"name":"Another institution"}'), `${origin}/staff`, org).length, 0);
  assert.equal(officialSiteRecords('<p>Avery Example, Teacher, email format first.last</p>', `${origin}/staff`, org).length, 0);
  assert.throws(() => officialSiteRecords('x'.repeat(256_001), `${origin}/staff`, org), /budget/);
});
test('network requires opt-in and domain review; robots failure/denial stops page request; budgets survive subsequent runs', async t => {
  const store = tempStore(t); let org;
  store.transaction(s => Object.assign(s, baseState())); org = store.read().organizations[0]; let calls = 0;
  const input = { organizationId: org.id, urls: [`${origin}/staff`], operator };
  await assert.rejects(() => crawlOfficial(store, input), /disabled/);
  await assert.rejects(() => crawlOfficial(store, { ...input, allowNetwork: true }), /approval/);
  store.transaction(s => domain(s));
  const get = async url => { calls++; assert.ok(url.endsWith('/robots.txt')); return { text: 'User-agent: *\nDisallow: /', type: 'text/plain' }; };
  await assert.rejects(() => crawlOfficial(store, { ...input, allowNetwork: true }, { get }), /disallows/); assert.equal(calls, 1);
  assert.equal(store.read().crawlUsage[0].requests, 1);
  await assert.rejects(() => crawlOfficial(store, { ...input, allowNetwork: true }, { get }), /rate limit/); assert.equal(calls, 1);
  store.transaction(s => { s.crawlUsage[0].lastAt = 0; s.crawlUsage[0].requests = 6; });
  await assert.rejects(() => crawlOfficial(store, { ...input, allowNetwork: true }, { get }), /budget/);
});
test('successful mocked crawl waits politeness interval, persists reservations, and quarantines all discoveries', async t => {
  const store = tempStore(t); store.transaction(s => { Object.assign(s, baseState()); domain(s); }); const org = store.read().organizations[0]; let calls = 0; let waited = 0;
  const get = async url => { calls++; return url.endsWith('robots.txt') ? { text: 'User-agent: *\nDisallow: /login\nCrawl-delay: 2', type: 'text/plain' } : { text: fixtureFile('official-staff.html'), type: 'text/html' }; };
  const pause = async ms => { waited += ms; store.transaction(s => { s.crawlUsage[0].lastAt = 0; }); };
  const result = await crawlOfficial(store, { organizationId: org.id, urls: [`${origin}/staff`], operator, allowNetwork: true }, { get, pause });
  assert.equal(result.added, 1); assert.equal(calls, 2); assert.equal(waited, 2000); assert.equal(store.read().crawlUsage[0].requests, 2); assert.equal(store.read().candidates[0].stage, 'discovered'); assert.equal(store.read().contacts.length, 0);
});
