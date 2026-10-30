import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { classify, parseNameStatus, inventory, violations, markdown } from './inventory.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/changes.json', import.meta.url)));
test('NUL records preserve names, renames and removals', () => {
  const raw = fixture.flatMap(c => [c.status, ...(c.oldPath ? [c.oldPath] : []), c.path]).join('\0') + '\0';
  assert.deepEqual(parseNameStatus(Buffer.from(raw)), fixture);
  assert.throws(() => parseNameStatus(Buffer.from('R100\0old\0')), /Truncated/);
});
test('categories fail conservatively for unknown packages', () => {
  for (const [path, category] of [['workshop-backend', 'runtime kernel'], ['workshop-shared', 'runtime kernel'], ['ui', 'UI shell'], ['educateos-policy', 'domain'], ['gatekeeper-google', 'integration'], ['new-runtime', 'runtime kernel']]) assert.equal(classify(`packages/${path}/a`).category, category);
  assert.equal(classify('scripts/release/a').category, 'release');
});
test('real Git fixture binds review to changes including rename out of kernel and deletion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'education-delta-'));
  const previous = process.cwd();
  const git = (...args) => execFileSync('git', args, { cwd: dir });
  try {
    git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
    mkdirSync(join(dir, 'packages/workshop-backend'), { recursive: true });
    writeFileSync(join(dir, 'packages/workshop-backend/old.ts'), 'unique rename content\n');
    writeFileSync(join(dir, 'packages/workshop-backend/remove.ts'), 'delete me\n');
    git('add', '.'); git('commit', '-qm', 'base'); git('tag', 'base');
    mkdirSync(join(dir, 'packages/educateos-policy'), { recursive: true });
    renameSync(join(dir, 'packages/workshop-backend/old.ts'), join(dir, 'packages/educateos-policy/new.ts'));
    rmSync(join(dir, 'packages/workshop-backend/remove.ts'));
    git('add', '.'); git('commit', '-qm', 'product');
    process.chdir(dir);
    const report = inventory('base', 'HEAD');
    assert.equal(report.entries.length, 2);
    assert.ok(report.entries.every(e => e.category === 'runtime kernel'));
    assert.ok(report.entries.some(e => e.status.startsWith('R') && e.oldPath));
    assert.ok(report.entries.some(e => e.status === 'D' && e.after === null));
    const manifest = { schemaVersion: 1, exceptions: report.entries.map(e => ({ path: e.path, fingerprint: e.fingerprint, rationale: 'Keep compatibility', review: 'fixture review' })) };
    assert.equal(violations(report, manifest).length, 0);
    manifest.exceptions[0].fingerprint = '0'.repeat(64);
    assert.equal(violations(report, manifest).length, 1);
    assert.equal(violations(report, { schemaVersion: 1, exceptions: [] }).length, 2);
    assert.throws(() => violations(report, { schemaVersion: 1, exceptions: [{ path: 'a' }] }), /Invalid/);
    assert.deepEqual(inventory('base', 'HEAD'), report);
    assert.equal(markdown(report), markdown(report));
    assert.throws(() => inventory('missing-ref', 'HEAD'));
    writeFileSync(join(dir, 'packages/workshop-backend/new.ts'), 'new kernel surface');
    git('add', '.'); git('commit', '-qm', 'new kernel file');
    assert.equal(violations(inventory('base', 'HEAD'), { schemaVersion: 1, exceptions: [] }).length, 3);
    const newReport = inventory('base', 'HEAD');
    const approved = { schemaVersion: 1, exceptions: newReport.entries.map(e => ({ path: e.path, fingerprint: e.fingerprint, rationale: 'Fixture', review: 'Fixture' })) };
    writeFileSync(join(dir, 'packages/workshop-backend/new.ts'), 'changed kernel surface');
    git('add', '.'); git('commit', '-qm', 'modify reviewed file');
    assert.equal(violations(inventory('base', 'HEAD'), approved).length, 1);
  } finally { process.chdir(previous); rmSync(dir, { recursive: true, force: true }); }
});

test('Markdown escapes table delimiters and embedded newlines', () => {
  const output = markdown({ upstreamCommit: 'a', headCommit: 'b', entries: fixture.map(e => ({ ...e, ...classify(e.path) })) });
  assert.ok(output.includes('pipe&#124;line&#10;'));
});
