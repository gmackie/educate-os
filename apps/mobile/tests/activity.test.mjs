import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clock, isFinished, permittedResources, readiness, spokenFrame, spokenText, stepWork, studentNotes, workByStep, workSteps, workTitle,
} from '../src/activity.ts';
import { gradeRange, isElementaryBand, isYoungLearnerBand } from '../src/gradeBand.ts';

const ref = { resourceId: 'res_story', version: '1.0.0' };
// The shape packages/educateos-curriculum/src/templates.ts makes for a picture response with "tell".
const picture = {
  title: 'My pet', overview: 'Draw your pet, then tell us about it.', gradeBand: 'K', template: 'picture-response',
  resources: [ref],
  codex: [
    { kind: 'note', id: 'tip', title: 'Tip', body: 'Use big shapes.', purpose: 'context', visibility: 'students' },
    { kind: 'note', id: 'key', title: 'Key', body: 'secret', purpose: 'answer-key', visibility: 'teacher-only' },
  ],
  steps: [
    { id: 'look', title: 'Look and listen', prompt: 'Look at the picture.', sources: [ref], response: { kind: 'none' } },
    { id: 'draw', title: 'Draw it', prompt: 'Draw your pet.', sources: [], response: { kind: 'artifact', artifactType: 'image' } },
    { id: 'tell', title: 'Tell about it', prompt: 'Tell about your picture.', sources: [], response: { kind: 'artifact', artifactType: 'audio' },
      sentenceFrames: ['My pet is ___.'] },
  ],
};
const view = (id, title, head = 'rev_' + id) => ({
  artifact: { id, workspaceId: 'ws', type: 'image', title, createdAt: '2026-11-01T00:00:00Z' },
  head: { id: head, number: 1, mediaType: 'image/png', createdAt: '2026-11-01T00:00:00Z' },
});

test('grade bands read as the web reads them', () => {
  assert.deepEqual(gradeRange('K-2'), { low: 0, high: 2 });
  assert.deepEqual(gradeRange('Grade 2'), { low: 2, high: 2 });
  assert.deepEqual(gradeRange('k – 2'), { low: 0, high: 2 });
  assert.deepEqual(gradeRange('3 to 1'), { low: 1, high: 3 });
  assert.equal(gradeRange('K-2-4'), undefined);
  assert.equal(gradeRange('ninth'), undefined);
  for (const band of ['K', 'PK', 'TK', '1', 'K-2', 'K-3', '2-3']) assert.ok(isYoungLearnerBand(band), band);
  for (const band of ['3', '3-5', '9-12', 'K-5', undefined, '']) assert.ok(!isYoungLearnerBand(band), String(band));
  assert.ok(isElementaryBand('3-5') && isElementaryBand('K-5') && !isElementaryBand('6-8'));
});

test('each step is made the way the phone can make it', () => {
  const [look, draw, tell] = picture.steps;
  assert.equal(stepWork(look), undefined);
  assert.deepEqual(stepWork(draw, { drawing: true }), { input: 'picture', artifactType: 'image', drawing: true });
  assert.deepEqual(stepWork(draw), { input: 'picture', artifactType: 'image', drawing: false });
  assert.deepEqual(stepWork(tell), { input: 'recording', artifactType: 'audio' });
  const step = (response) => ({ id: 's', title: 's', prompt: 'p', sources: [], response });
  assert.equal(stepWork(step({ kind: 'writing' })).input, 'writing');
  assert.equal(stepWork(step({ kind: 'artifact', artifactType: 'document' })).input, 'writing');
  assert.deepEqual(stepWork(step({ kind: 'artifact', artifactType: 'evidence' })), { input: 'photo', artifactType: 'evidence' });
  assert.equal(stepWork(step({ kind: 'dataset', columns: [{ name: 'x' }] })).input, 'elsewhere');
  assert.equal(stepWork(step({ kind: 'artifact', artifactType: 'notebook' })).input, 'elsewhere');
});

test('saved work is found by the title the web saves it under, ignoring deleted work', () => {
  assert.deepEqual(workSteps(picture).map((s) => s.id), ['draw', 'tell']);
  assert.equal(workTitle('My pet', picture.steps[1]), 'My pet: Draw it');
  assert.equal(workTitle('x'.repeat(250), picture.steps[1]).length, 200);
  const deleted = { ...view('a2', 'My pet: Tell about it'), artifact: { ...view('a2', 'My pet: Tell about it').artifact, deletedAt: '2026-11-02T00:00:00Z' } };
  const found = workByStep('My pet', picture, [view('a1', 'My pet: Draw it'), deleted, view('a3', 'Other: Draw it')]);
  assert.deepEqual([...found.keys()], ['draw']);
  assert.equal(found.get('draw').artifact.id, 'a1');
});

test('a picture response is never submitted with only the picture', () => {
  const drawn = new Map([['draw', view('a1', 'My pet: Draw it')]]);
  const partial = readiness(picture, drawn, new Set());
  assert.equal(partial.ready, false);
  assert.deepEqual(partial.missing.map((s) => s.id), ['tell']);
  assert.match(partial.reason, /Tell about it/);
  assert.equal(readiness(picture, drawn, new Set(), { young: true }).reason, 'Finish “Tell about it” first.');

  const all = new Map([...drawn, ['tell', view('a2', 'My pet: Tell about it', 'rev_tell2')]]);
  assert.deepEqual(readiness(picture, all, new Set()), { ready: true, revisions: [
    { artifactId: 'a1', revisionId: 'rev_a1' }, { artifactId: 'a2', revisionId: 'rev_tell2' },
  ] });
  // Unsaved typing blocks it: a submission takes saved versions only.
  const dirty = readiness(picture, all, new Set(['tell']));
  assert.equal(dirty.ready, false);
  assert.match(dirty.reason, /Save your changes/);
  // An activity that asks for nothing has nothing to submit.
  assert.equal(readiness({ ...picture, steps: [picture.steps[0]] }, new Map(), new Set()).ready, false);
});

test('resources are listed with the steps that use them, and only student notes show', () => {
  assert.deepEqual(permittedResources(picture), [{ key: 'res_story@1.0.0', title: 'Resource 1', usedIn: ['Look and listen'] }]);
  assert.deepEqual(studentNotes(picture), [{ id: 'tip', title: 'Tip', body: 'Use big shapes.' }]);
  assert.deepEqual(permittedResources({ ...picture, resources: undefined }), []);
});

test('read-aloud text: blanks are pauses and Markdown marks are not spoken', () => {
  assert.equal(spokenFrame('I see a ___.'), 'I see a  … .');
  assert.equal(spokenText('Look at **the** [picture](https://x.test) and say I see ___ and ___.'),
    'Look at the picture and say I see  …  and  … .');
  assert.equal(clock(0), '0:00');
  assert.equal(clock(119.6), '1:59');
  assert.equal(clock(120), '2:00');
});

test('a finished term makes the class workspace read-only', () => {
  assert.equal(isFinished(undefined), false);
  assert.equal(isFinished({ lifecycle: 'active' }), false);
  for (const lifecycle of ['completed', 'retained', 'eligible-for-deletion']) assert.equal(isFinished({ lifecycle }), true);
});
