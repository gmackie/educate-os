// Offline UI smoke: real static pages/scripts; network APIs and Turnstile are fixtures.
// Run: node sites/educateos-io/listening/browser-check.mjs
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {NOTICE_VERSION, QUESTIONS} from './schema.mjs';
const {chromium} = createRequire(new URL('../../../packages/workshop-frontend/package.json', import.meta.url))('playwright');
const browser = await chromium.launch({channel: 'chrome', headless: true});
let submissions = [];
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'challenges.cloudflare.com') return route.fulfill({contentType: 'text/javascript', body: `window.turnstile={render(selector, options){queueMicrotask(()=>options.callback('fixture-token'));return 1;},reset(){}};`});
    assert.equal(url.origin, 'https://educateos.io');
    if (url.pathname === '/api/listening/config') return route.fulfill({json: {siteKey: 'fixture-sitekey', noticeVersion: NOTICE_VERSION}});
    if (url.pathname.startsWith('/api/listening/')) {submissions.push(JSON.parse(route.request().postData())); return route.fulfill({json: {ok: true}});}
    const path = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    try {
      const body = await readFile(fileURLToPath(new URL('../public' + path, import.meta.url)));
      return route.fulfill({body, contentType: path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : 'text/css'});
    } catch { return route.fulfill({status: 404, body: ''}); }
  });
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({width, height: 900});
    for (const path of ['/have-your-say/', '/have-your-say/follow-up/', '/have-your-say/privacy/']) {
      await page.goto('https://educateos.io' + path);
      assert.equal(await page.locator('h1').count(), 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}: ${path}`);
      const labelsMissing = await page.locator('input:not([name=honeypot])').evaluateAll(inputs => inputs.filter(i => !i.labels.length).length);
      assert.equal(labelsMissing, 0);
    }
  }
  await page.goto('https://educateos.io/have-your-say/');
  await page.keyboard.press('Tab'); assert.equal(await page.locator('.skip').evaluate(e => e === document.activeElement), true);
  assert.equal(await page.locator('input:checked').count(), 0);
  await page.locator('input[name=adult]').check(); await page.locator('input[name=participation]').check();
  await page.getByRole('button', {name: 'Send response'}).click();
  await page.waitForFunction(() => document.querySelector('#result').textContent.includes('deletion code'));
  assert.equal(submissions.length, 1); assert.equal(submissions[0].email, undefined);
  for (const key of Object.keys(QUESTIONS)) assert.deepEqual(submissions[0][key], []);
  await page.goto('https://educateos.io/have-your-say/follow-up/');
  await page.locator('input[name=email]').fill('adult@example.invalid'); await page.locator('input[name=topic]').first().check();
  await page.locator('input[name=adult]').check(); await page.locator('input[name=participation]').check();
  await page.getByRole('button', {name: 'Send response'}).click(); assert.equal(submissions.length, 1, 'follow-up opt-in is required');
  await page.locator('input[name=followUpConsent]').check(); await page.getByRole('button', {name: 'Send response'}).click();
  await page.waitForFunction(() => document.querySelector('#result').textContent.includes('request was received'));
  assert.equal(submissions.length, 2); assert.equal(submissions[1].followUpConsent, true);
  assert.notEqual(submissions[0].receipt, submissions[1].receipt);
  assert.equal(submissions[1].tools, undefined); assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  // Closed mode keeps readable questions and does not request Turnstile.
  await page.unroute('**/*');
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.notEqual(url.hostname, 'challenges.cloudflare.com');
    if (url.pathname === '/api/listening/config') return route.fulfill({status: 503, json: {ok: false}});
    const path = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    try { return route.fulfill({body: await readFile(fileURLToPath(new URL('../public' + path, import.meta.url))), contentType: path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : 'text/css'}); }
    catch { return route.fulfill({status: 404}); }
  });
  await page.goto('https://educateos.io/have-your-say/');
  assert.equal(await page.locator('input[name=adult]').isDisabled(), true);
  assert.match(await page.locator('#availability').textContent(), /closed/);
  console.log('PASS: nine responsive page checks, keyboard skip, labels, optional answers, separate opt-in, no browser persistence, closed collection. API/Turnstile fixtures only.');
} finally { await browser.close(); }
