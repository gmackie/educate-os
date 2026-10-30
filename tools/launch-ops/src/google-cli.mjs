import { readFileSync, statSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { check } from './safety.mjs';
import { GoogleApi } from './google-api.mjs';
import { createGmailDraft, reconcileDraft, reconcileSent, readReplies, createCalendarHold, reconcileHold } from './google-bridge.mjs';
import { simulateGoogle } from './simulate-google.mjs';

export const GOOGLE_HELP = `
Google bridge: local preview/review via funnel google.preview/google.approve,
meeting-request.accept, calendar.propose/calendar.preview/calendar.approve, meeting.review.
  simulate-google                             full synthetic lifecycle in temporary store, offline
  google-draft --allow-network --create-gmail-draft <private.json>
  google-reconcile-draft --allow-network --read-google <private.json>
  google-reconcile-sent --allow-network --read-google <private.json>
  google-replies --allow-network --read-google <private.json>
  calendar-hold --allow-network --create-calendar-hold <private.json>
  calendar-reconcile --allow-network --read-google <private.json>
See GOOGLE.md for exact v1 input fields, uncertain lock release and OAuth bring-up.
`;
const commands = {
  'google-draft': ['--create-gmail-draft', 'createGmailDraft', createGmailDraft],
  'google-reconcile-draft': ['--read-google', 'readGoogle', reconcileDraft],
  'google-reconcile-sent': ['--read-google', 'readGoogle', reconcileSent], 'google-replies': ['--read-google', 'readGoogle', readReplies],
  'calendar-hold': ['--create-calendar-hold', 'createCalendarHold', createCalendarHold], 'calendar-reconcile': ['--read-google', 'readGoogle', reconcileHold],
};
export const isGoogleCommand = command => command === 'simulate-google' || Object.hasOwn(commands, command);
export async function runGoogleCommand(store, command, args, api) {
  if (command === 'simulate-google') {
    check(args.length === 0, 'simulate-google takes no arguments'); const root = mkdtempSync(join(realpathSync(tmpdir()), 'launch-ops-google-synthetic-'));
    try { const { state: _state, ...result } = await simulateGoogle(new Store(root)); return result; } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const spec = commands[command]; check(spec && args.length === 3 && args[0] === '--allow-network' && args[1] === spec[0], 'Explicit exact Google CLI flags and one private JSON file required');
  check(statSync(args[2]).size <= 20_000, 'Google input must be <=20KB'); const input = JSON.parse(readFileSync(args[2], 'utf8'));
  check(input.schemaVersion === 1 && typeof input.id === 'string' && Object.keys(input).every(k => ['schemaVersion', 'id', 'handoffId', 'reviewedHash'].includes(k)), 'Google execution input v1 fields only; no tokens or attendee fields');
  return spec[2](store, { ...input, allowNetwork: true, [spec[1]]: true }, api || new GoogleApi());
}
