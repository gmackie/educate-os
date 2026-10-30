import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, darkPalette, lightPalette, paletteFor, resolveMode, themeScript } from '../src/theme.ts';
import { homeTab, tabsFor } from '../src/tabs.ts';

test('the mode follows the system unless overridden', () => {
  assert.equal(resolveMode('system', 'dark'), 'dark');
  assert.equal(resolveMode('system', 'light'), 'light');
  assert.equal(resolveMode('system', null), 'light');
  assert.equal(resolveMode('light', 'dark'), 'light');
  assert.equal(resolveMode('dark', 'light'), 'dark');
});

test('both palettes keep body text and primary actions readable', () => {
  for (const p of [lightPalette, darkPalette]) {
    assert.deepEqual(Object.keys(p).sort(), Object.keys(lightPalette).sort());
    assert.ok(contrast(p.ink, p.background) >= 7, 'ink');
    assert.ok(contrast(p.muted, p.surface) >= 4.5, 'muted');
    assert.ok(contrast(p.onPrimary, p.primary) >= 4.5, 'onPrimary');
  }
});

test('a school accent becomes the primary colour, adjusted to stay readable', () => {
  assert.equal(paletteFor('light', '#2458ac').primary, '#2458AC');
  assert.deepEqual(paletteFor('light', null), lightPalette);
  assert.deepEqual(paletteFor('dark', 'not-a-colour'), darkPalette);
  for (const accent of ['#2458ac', '#ffd400', '#0a0a0a', '#22aa55']) {
    for (const mode of ['light', 'dark']) {
      const p = paletteFor(mode, accent);
      assert.ok(contrast(p.primary, p.background) >= 4.5 || contrast(p.onPrimary, p.primary) >= 4.5, accent + ' ' + mode);
      assert.ok(contrast(p.onPrimary, p.primary) >= 3, accent + ' ' + mode + ' button text');
    }
  }
});

test('the AI workspace is told the mode before load, through both stored keys', () => {
  const script = themeScript('dark', '#2458ac');
  assert.match(script, /"educateos:theme-mode","gadgets:theme-mode"/);
  assert.match(script, /setAttribute\("data-mode","dark"\)/);
  assert.match(script, /colorScheme="dark"/);
  assert.match(script, /--educateos-accent","#2458ac"/);
  assert.doesNotMatch(themeScript('light', '");alert(1);("'), /alert/, 'only hex accents are injected');
});

test('five role-aware tabs, and AI hidden when the school has none', () => {
  assert.deepEqual(tabsFor('student'), ['today', 'classes', 'ai', 'inbox', 'me']);
  assert.deepEqual(tabsFor('teacher'), ['today', 'classes', 'review', 'ai', 'me']);
  assert.deepEqual(tabsFor('guardian'), ['family', 'agenda', 'inbox', 'me']);
  assert.deepEqual(tabsFor('student', { ai: false }), ['today', 'classes', 'inbox', 'me']);
  assert.deepEqual(tabsFor('teacher', { ai: true }), ['today', 'classes', 'review', 'ai', 'me']);
  assert.equal(homeTab('guardian'), 'family');
  assert.equal(homeTab('teacher'), 'today');
});
