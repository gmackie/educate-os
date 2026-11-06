import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {stamp} from './stamp.mjs';

const source = readFileSync(new URL('./public/assets/dataflare.js', import.meta.url), 'utf8');
const html = '<!-- site:header --><!-- /site:header --><!-- site:footer --><!-- /site:footer --></body>';

test('marketing mount defaults off and is idempotent', () => {
  const result = stamp(html, '/teachers/');
  assert.match(result, /dataflare.js" data-enabled="false"/);
  assert.equal(stamp(result, '/teachers/'), result);
});
test('restricted pages never receive an analytics mount', () => {
  for (const path of ['/demo/', '/app', '/interest/demo/', '/registry/abc', '/district/student', '/clever/launch']) {
    assert.doesNotMatch(stamp(html, path), /dataflare.js/);
    // Even copying the marketing bootstrap to one of these pages cannot load a remote SDK.
    runInNewContext(source, {document: {currentScript: {dataset: {enabled: 'true'}}, createElement() {throw new Error('Unexpected remote SDK load');}}, location: {pathname: path}});
  }
});
