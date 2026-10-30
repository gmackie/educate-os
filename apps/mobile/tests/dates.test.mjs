import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localInput, parseLocal } from '../src/dates.ts';

test('due dates round-trip through the local form', () => {
  const due = new Date(2026, 10, 5, 15, 30);
  assert.equal(localInput(due.toISOString()), '2026-11-05 15:30');
  assert.equal(parseLocal('2026-11-05 15:30')?.getTime(), due.getTime());
  assert.equal(parseLocal('2026-11-05T09:05')?.getHours(), 9);
});

test('impossible or malformed dates are refused', () => {
  for (const value of ['2026-02-30 10:00', '2026-13-01 10:00', 'next friday', '2026-11-05']) assert.equal(parseLocal(value), null, value);
});
