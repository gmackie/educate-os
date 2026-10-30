import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const git = (...args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
export function classify(path) {
  const pkg = path.startsWith('packages/') ? path.split('/')[1] : '(repository)';
  let category = 'release';
  if (/^packages\/(workshop-backend|workshop-shared|router|typed-storage|sandbox)(\/|$)/.test(path)) category = 'runtime kernel';
  else if (/^packages\/(workshop-frontend|ui|configurator-ui)(\/|$)/.test(path)) category = 'UI shell';
  else if (/^packages\/(gatekeeper-|mcp-|educateos-integrations)/.test(path)) category = 'integration';
  else if (/^packages\/(educateos-|bundled-blueprints)/.test(path)) category = 'domain';
  // Unrecognized packages are conservative: adding a new runtime cannot evade review.
  else if (pkg !== '(repository)') category = 'runtime kernel';
  return { package: pkg, category };
}

export function parseNameStatus(buffer) {
  const fields = buffer.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!/^(A|M|D|T|R\d+|C\d+)$/.test(status)) throw new Error(`Unsupported diff status: ${status}`);
    const oldPath = fields[i++];
    const path = /^[RC]/.test(status) ? fields[i++] : oldPath;
    if (!path || !oldPath) throw new Error('Truncated name-status diff');
    changes.push({ status, path, ...(/^[RC]/.test(status) ? { oldPath } : {}) });
  }
  return changes;
}

export function inventory(upstream, head) {
  const upstreamCommit = git('rev-parse', '--verify', `${upstream}^{commit}`).toString().trim();
  const headCommit = git('rev-parse', '--verify', `${head}^{commit}`).toString().trim();
  const tree = commit => new Map(git('ls-tree', '-r', '-z', commit).toString().split('\0').filter(Boolean).map(record => {
    const tab = record.indexOf('\t');
    return [record.slice(tab + 1), record.slice(0, tab).split(' ')[2]];
  }));
  const beforeTree = tree(upstreamCommit);
  const afterTree = tree(headCommit);
  const entries = parseNameStatus(git('diff', '--name-status', '-z', '--find-renames', upstreamCommit, headCommit)).map(change => {
    const classifications = [classify(change.path), ...(change.oldPath ? [classify(change.oldPath)] : [])];
    const classification = classifications.find(c => c.category === 'runtime kernel') ?? classifications[0];
    // Full blob IDs, status and both names bind review to content, deletion and rename direction.
    const before = beforeTree.get(change.oldPath ?? change.path) ?? null;
    const after = afterTree.get(change.path) ?? null;
    const fingerprint = createHash('sha256').update(JSON.stringify({ ...change, before, after })).digest('hex');
    return { ...change, ...classification, before, after, fingerprint };
  }).toSorted((a, b) => a.package.localeCompare(b.package, 'en') || a.path.localeCompare(b.path, 'en'));
  return { schemaVersion: 1, upstreamCommit, headCommit, entries };
}

export function violations(report, manifest) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.exceptions)) throw new Error('Invalid exceptions manifest');
  const seen = new Set();
  for (const item of manifest.exceptions) {
    if (!item.path || !/^[a-f0-9]{64}$/.test(item.fingerprint) || !item.rationale?.trim() || !item.review?.trim() || seen.has(item.path)) throw new Error('Invalid or duplicate exception');
    seen.add(item.path);
  }
  return report.entries.filter(entry => entry.category === 'runtime kernel' && !manifest.exceptions.some(item => item.path === entry.path && item.fingerprint === entry.fingerprint));
}

const cell = value => String(value).replaceAll('|', '&#124;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;').replaceAll('<', '&lt;');
export function markdown(report) {
  const lines = ['# Upstream delta inventory', '', `Upstream: \`${report.upstreamCommit}\``, `Head: \`${report.headCommit}\``, '', '| Package | Category | Status | Path | Previous path |', '| --- | --- | --- | --- | --- |'];
  for (const e of report.entries) lines.push(`| ${[e.package, e.category, e.status, e.path, e.oldPath ?? ''].map(cell).join(' | ')} |`);
  return lines.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = { '--upstream': 'upstream/main', '--head': 'HEAD', '--out': '/tmp/educateos-delta', '--manifest': 'scripts/education-architecture/exceptions.json' };
  for (let i = 0; i < args.length; i += 2) {
    if (!(args[i] in options) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${args[i]}`);
    options[args[i]] = args[i + 1];
  }
  const report = inventory(options['--upstream'], options['--head']);
  mkdirSync(options['--out'], { recursive: true });
  writeFileSync(resolve(options['--out'], 'inventory.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(resolve(options['--out'], 'inventory.md'), markdown(report));
  const failures = violations(report, JSON.parse(readFileSync(options['--manifest'], 'utf8')));
  console.log(`${report.entries.length} changed files; ${failures.length} kernel changes require review. Reports: ${options['--out']}`);
  if (failures.length) {
    console.error(failures.map(e => `${e.status} ${e.path}: ${e.fingerprint}`).join('\n'));
    process.exitCode = 1;
  }
}
