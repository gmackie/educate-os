import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moduleRows, provenance, safeLink, teacherNoteFor } from '../src/modules.ts';
import { CANVAS_HEIGHT, CANVAS_WIDTH, canvasPoint, exportViewSize, extend, strokePath } from '../src/drawing.ts';

const pages = [{ id: 'pg_1', title: 'Welcome', body: 'Hi' }, { id: 'pg_key', title: 'Answer key', body: 'B' }];
const module = {
  id: 'cmod_1', title: 'Unit 1', published: true,
  source: { kind: 'course', packageId: 'educateos.io/grade-1-reading-foundations', version: '1.0.1', packageDigest: 'sha256:' + '0'.repeat(64), unitKey: 'u1' },
  items: [
    { kind: 'page', id: 'cit_1', pageId: 'pg_1' },
    { kind: 'activity', id: 'cit_2', activityId: 'act_1' },
    { kind: 'link', id: 'cit_3', title: 'Read online', url: 'https://example.org/story' },
    { kind: 'link', id: 'cit_4', title: 'Bad', url: 'javascript:alert(1)' },
    { kind: 'teacher-note', id: 'cit_5', pageId: 'pg_key', purpose: 'answer-key' },
    { kind: 'page', id: 'cit_6', pageId: 'pg_missing' },
    { kind: 'quiz-from-the-future', id: 'cit_7' },
  ],
};

test('students see pages, activities and links, never teacher notes', () => {
  assert.deepEqual(moduleRows(module, pages, 'student').map((r) => [r.kind, r.id]), [
    ['page', 'cit_1'], ['activity', 'cit_2'], ['link', 'cit_3'], ['link', 'cit_4'],
  ]);
  const links = moduleRows(module, pages, 'student').filter((r) => r.kind === 'link');
  assert.equal(links[0].url, 'https://example.org/story');
  assert.equal(links[1].url, null, 'an unsafe link is shown, not opened');
});

test('teachers also see teacher notes, labelled, and where a module came from', () => {
  const note = moduleRows(module, pages, 'teacher').find((r) => r.kind === 'teacher-note');
  assert.equal(note.label, 'Answer key');
  assert.equal(note.page.title, 'Answer key');
  assert.equal(teacherNoteFor([module], 'pg_key'), 'Answer key');
  assert.equal(teacherNoteFor([module], 'pg_1'), null);
  assert.equal(provenance(module.source), 'Installed from educateos.io/grade-1-reading-foundations 1.0.1');
  assert.equal(provenance({ kind: 'cartridge', fileName: 'unit.imscc', packageDigest: 'x' }), 'Imported from unit.imscc');
  assert.equal(provenance(undefined), null);
});

test('only plain https links are opened', () => {
  assert.equal(safeLink('https://example.org/a?b=1'), 'https://example.org/a?b=1');
  for (const bad of ['http://example.org', 'javascript:alert(1)', 'https://user:pw@example.org', 'educateos://class/1', 'file:///etc', '', 'not a url']) {
    assert.equal(safeLink(bad), null, bad);
  }
});

test('the drawing pad maps touches onto its fixed canvas and draws dots and lines', () => {
  assert.deepEqual(canvasPoint(160, 120, 320, 240), { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 });
  assert.deepEqual(canvasPoint(-5, 999, 320, 240), { x: 0, y: CANVAS_HEIGHT });
  const dot = { color: '#000', width: 14, points: [{ x: 1, y: 2 }] };
  assert.equal(strokePath(dot), 'M1 2L1 2');
  assert.equal(strokePath({ ...dot, points: [] }), '');
  const line = extend(extend(dot, { x: 1.5, y: 2 }), { x: 10, y: 20 });
  assert.equal(line.points.length, 2, 'a point too close to the last is skipped');
  assert.equal(strokePath(line), 'M1 2L10 20');
});

test('a drawing exports from a view that is the whole canvas in pixels at any screen scale', () => {
  for (const ratio of [1, 2, 3, 2.625]) {
    const { width, height } = exportViewSize(ratio);
    assert.ok(Math.abs(width * ratio - CANVAS_WIDTH) < 1e-9);
    assert.ok(Math.abs(height * ratio - CANVAS_HEIGHT) < 1e-9);
  }
  assert.deepEqual(exportViewSize(3), { width: 320, height: 240 });
  for (const broken of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(exportViewSize(broken), { width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
  }
});
