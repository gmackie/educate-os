import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {stamp} from './stamp.mjs';

const source = readFileSync(new URL('./public/assets/dataflare.js', import.meta.url), 'utf8');
const html = '<!-- site:header --><!-- /site:header --><!-- site:footer --><!-- /site:footer --></body>';

test('marketing mount defaults off and is idempotent', () => {
  const result = stamp(html, '/teachers/');
  assert.match(result, /dataflare.js" data-enabled="true"/);
  assert.equal(stamp(result, '/teachers/'), result);
});
test('restricted pages never receive an analytics mount', () => {
  for (const path of ['/demo/', '/app', '/interest/demo/', '/registry/abc', '/district/student', '/clever/launch']) {
    assert.doesNotMatch(stamp(html, path), /dataflare.js/);
    // Even copying the marketing bootstrap to one of these pages cannot load a remote SDK.
    runInNewContext(source, browser(path, () => {throw new Error('Unexpected remote SDK load');}));
  }
});

// A minimal browser for the journey loader v2: it needs window, navigator and document.head.
function browser(pathname, createElement) {
  const window = {};
  return {window, navigator: {}, location: {pathname, hash: '', search: ''}, document: {currentScript: {dataset: {enabled: 'true'}}, head: {append() {}}, createElement}};
}

test('the loader collects only the reviewed marketing paths, cookieless and without identify', () => {
  const loads = (path) => {
    let loaded = false;
    runInNewContext(source, browser(path, () => { loaded = true; return {addEventListener() {}}; }));
    return loaded;
  };
  for (const path of ['/', '/teachers/', '/leaders', '/families/', '/developers/', '/developers/mcp', '/gadgets/', '/connectors/x', '/pricing', '/privacy/']) {
    assert.equal(loads(path), true, path);
  }
  for (const path of ['/teachers/demo', '/interest/', '/tour/', '/demo/', '/privacy/extra', '/app']) {
    assert.equal(loads(path), false, path);
  }
  assert.match(source, /project: 'educateos-site'/);
  assert.match(source, /persistence: 'cookieless'/);
  assert.match(source, /identify: false/);
  assert.match(source, /replay: false/);
});
