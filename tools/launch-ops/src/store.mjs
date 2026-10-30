import { constants, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, id, now } from './safety.mjs';

export const PRIVATE_ROOT = fileURLToPath(new URL('../.private/', import.meta.url));
export const FUNNEL_COLLECTIONS = ['organizations', 'sourceImports', 'candidates', 'domainApprovals', 'campaigns', 'outreach', 'responses', 'staffFeedback', 'triage', 'suppressions', 'runs', 'operatorConfigs', 'privacyKeys', 'handoffs', 'importReceipts', 'crawlUsage', 'deliveries'];
export function emptyState() {
  return { version: 1, contacts: [], invitations: [], memberships: [], meetings: [], feedback: [], pilots: [], evidence: [], tickets: [], audit: [], ...Object.fromEntries(FUNNEL_COLLECTIONS.map(k => [k, []])) };
}
function noSymlinks(path) {
  const full = resolve(path); let cursor = parse(full).root;
  for (const part of full.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    let info;
    try { info = lstatSync(cursor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info) check(!info.isSymbolicLink(), 'Private path must not contain symlinks');
  }
}
function privateDirectory(path) {
  noSymlinks(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  check(lstatSync(path).isDirectory(), 'Private path must be a directory');
  chmodSync(path, 0o700);
}
function readPrivate(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}
export class Store {
  constructor(root = PRIVATE_ROOT) {
    this.root = resolve(root);
    privateDirectory(this.root);
    this.statePath = join(this.root, 'state.json');
    this.lockPath = join(this.root, 'transaction.lock');
    this.exportsPath = join(this.root, 'exports');
    privateDirectory(this.exportsPath);
  }
  read() {
    noSymlinks(this.root);
    try { check(!lstatSync(this.statePath).isSymbolicLink(), 'Private state must not be a symlink'); }
    catch (error) { if (error.code === 'ENOENT') return emptyState(); throw error; }
    const state = JSON.parse(readPrivate(this.statePath));
    check(state.version === 1, 'Unsupported state version');
    // Additive migration: PR #7 stores retain their records and approval semantics.
    for (const key of FUNNEL_COLLECTIONS) state[key] ??= [];
    for (const key of Object.keys(emptyState()).filter(k => k !== 'version')) check(Array.isArray(state[key]), 'Invalid private state');
    return state;
  }
  transaction(fn) {
    noSymlinks(this.root);
    let lock;
    try { lock = openSync(this.lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { throw new Error('Private store is locked; retry or inspect the stopped process before removing transaction.lock'); }
    const temp = join(this.root, `${id()}.tmp`);
    try {
      const state = this.read();
      const result = fn(state);
      check(!(result instanceof Promise), 'Transactions must be synchronous');
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.statePath);
      return result;
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
      closeSync(lock); unlinkSync(this.lockPath);
    }
  }
  purgeExports() {
    privateDirectory(this.exportsPath);
    for (const name of readdirSync(this.exportsPath)) {
      check(/^[a-f0-9-]{36}\.(?:json|csv|eml)$/.test(name), 'Unexpected export file; inspect manually');
      const path = join(this.exportsPath, name); check(!lstatSync(path).isSymbolicLink(), 'Export symlink refused'); unlinkSync(path);
    }
  }
  exportFile(content, extension) {
    check(['csv', 'json', 'eml'].includes(extension), 'Invalid export type');
    privateDirectory(this.exportsPath);
    const name = `${id()}.${extension}`;
    const path = join(this.exportsPath, name);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    return { name, path };
  }
}
export function audit(state, event, subject, actor = 'local operator') {
  state.audit.push({ id: id(), at: now(), event, subject, actor });
}
