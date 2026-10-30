import { constants, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, id, now } from './safety.mjs';

export const PRIVATE_ROOT = fileURLToPath(new URL('../.private/', import.meta.url));
export function emptyState() {
  return { version: 1, contacts: [], invitations: [], memberships: [], meetings: [], feedback: [], pilots: [], evidence: [], tickets: [], audit: [] };
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
  exportFile(content, extension) {
    check(['csv', 'json'].includes(extension), 'Invalid export type');
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
