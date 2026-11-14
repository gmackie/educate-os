import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {stamp} from './stamp.mjs';

// The funnel events journey.js adds on the marketing pages (SCHO-400).
const source = readFileSync(new URL('./public/assets/journey.js', import.meta.url), 'utf8');

class Element {
  constructor(href) { this.href = href; }
  closest(selector) { return selector === 'a[href]' && this.href !== null ? this : null; }
  getAttribute(name) { return name === 'href' ? this.href : null; }
}

/** Runs journey.js in a minimal browser at `pathname` and returns its listeners and tracked calls. */
function load(pathname, dataflare = 'recording') {
  const tracked = [];
  const listeners = {};
  const on = (name, fn) => { listeners[name] = fn; };
  const window = {addEventListener: on};
  // Props built in the vm realm are copied out, so deepEqual compares plain values.
  if (dataflare === 'recording') window.dataflare = {track: (event, props) => tracked.push(JSON.parse(JSON.stringify([event, props])))};
  if (dataflare === 'throwing') window.dataflare = {track: () => { throw new Error('loader broke'); }};
  const href = `https://educateos.io${pathname}`;
  runInNewContext(source, {window, document: {addEventListener: on}, location: {pathname, href}, Element, URL});
  return {tracked, listeners, journey: window.educateosJourney};
}

test('a district overview download is recorded with the page it came from', () => {
  const {tracked, listeners} = load('/leaders/');
  listeners.click({target: new Element('/educateos-district-overview.pdf')});
  listeners.click({target: new Element('https://educateos.io/educateos-district-overview.pdf')});
  listeners.click({target: new Element('/pilot/')});
  listeners.click({target: new Element(null)});
  listeners.click({target: {}});
  assert.deepEqual(tracked, [
    ['overview_downloaded', {page: 'leaders'}],
    ['overview_downloaded', {page: 'leaders'}],
  ]);
});

test('printing the founding pilot page is recorded, printing other pages is not', () => {
  const pilot = load('/pilot/');
  pilot.listeners.beforeprint();
  assert.deepEqual(pilot.tracked, [['pilot_kit_printed', {page: 'pilot'}]]);
  const pricing = load('/pricing');
  pricing.listeners.beforeprint();
  assert.deepEqual(pricing.tracked, []);
});

test('the page prop is a small enum, never a free-form path', () => {
  assert.equal(load('/').journey.pageKey(), 'home');
  assert.equal(load('/it/install/').journey.pageKey(), 'it');
  assert.equal(load('/Ünïcode/').journey.pageKey(), 'other');
  assert.equal(load(`/${'a'.repeat(40)}`).journey.pageKey(), 'other');
});

test('without the loader, or when it throws, the page keeps working', () => {
  for (const mode of ['missing', 'throwing']) {
    const {listeners, journey} = load('/pilot/', mode);
    assert.doesNotThrow(() => listeners.click({target: new Element('/educateos-district-overview.pdf')}));
    assert.doesNotThrow(() => listeners.beforeprint());
    assert.doesNotThrow(() => journey.track('cta_clicked', {location: 'test'}));
  }
});

test('journey.js is mounted with the loader on marketing pages and never on restricted ones', () => {
  const html = '<!-- site:header --><!-- /site:header --><!-- site:footer --><!-- /site:footer --></body>';
  assert.match(stamp(html, '/pilot/'), /dataflare\.js" data-enabled="true"><\/script><script defer src="\/assets\/journey\.js">/);
  for (const path of ['/demo/', '/interest/', '/feedback/', '/app', '/district/student', '/courses/']) {
    assert.doesNotMatch(stamp(html, path), /journey\.js/, path);
  }
});

test('journey.js has no identify or reset: the site has no accounts and is cookieless', () => {
  assert.doesNotMatch(source, /\.identify\(|\.reset\(/);
});
