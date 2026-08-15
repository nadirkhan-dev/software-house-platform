import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mondayOf } from '../src/dates.js';

/**
 * Calendar handling, pinned across timezones.
 *
 * These exist because a DATE was being turned into an instant. On Asia/Karachi
 * a `worked_on` of 2026-06-01 left the API as 2026-05-31 and billable hours
 * landed in the previous month, with nothing failing to say so. A test that
 * only ever runs in the CI box's timezone cannot see that class of bug, so the
 * timezone-sensitive assertions run in child processes with TZ set.
 *
 * Kiritimati (+14) and Midway (−11) are the extremes of the inhabited range:
 * if both pass, everything between them does.
 */

const ZONES = ['UTC', 'Asia/Karachi', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Midway'];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Runs a snippet in a child process under a given TZ and returns its stdout. */
const inZone = (tz, code) =>
  execFileSync(process.execPath, ['-e', code], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, TZ: tz },
  }).trim();

/* --------------------------------------------------------------- mondayOf */

test('mondayOf pins the Monday of the containing week', () => {
  // 2026-06-01 is itself a Monday; 06-07 is the Sunday that closes that week.
  assert.equal(mondayOf('2026-06-01'), '2026-06-01', 'a Monday is its own Monday');
  assert.equal(mondayOf('2026-06-04'), '2026-06-01');
  assert.equal(mondayOf('2026-06-07'), '2026-06-01', 'Sunday belongs to the week that opened');
  assert.equal(mondayOf('2026-06-08'), '2026-06-08', 'the next Monday starts a new week');

  // Boundaries worth pinning: a year edge, a month edge, and a leap day.
  assert.equal(mondayOf('2026-01-01'), '2025-12-29', 'a week may open in the previous year');
  assert.equal(mondayOf('2026-12-31'), '2026-12-28');
  assert.equal(mondayOf('2024-02-29'), '2024-02-26', 'leap day');
  assert.equal(mondayOf('2026-03-08'), '2026-03-02');
});

test('mondayOf accepts a Date as well as a string', () => {
  assert.equal(mondayOf(new Date('2026-06-04T00:00:00Z')), '2026-06-01');
  assert.equal(mondayOf(new Date('2026-06-04T23:59:59Z')), '2026-06-01');
});

test('mondayOf rejects what is not a date rather than returning a wrong week', () => {
  assert.throws(() => mondayOf('not-a-date'), TypeError);
});

test('mondayOf returns the same Monday in every timezone', () => {
  // The old implementation mixed local getters with toISOString(), so this is
  // the assertion that would have caught it: west of UTC it fell a week back.
  const code = `import('./src/dates.js').then(({mondayOf}) => console.log(
    ['2026-06-01','2026-06-04','2026-06-07','2026-01-01','2024-02-29'].map(mondayOf).join(',')));`;
  const expected = '2026-06-01,2026-06-01,2026-06-01,2025-12-29,2024-02-26';
  for (const tz of ZONES) {
    assert.equal(inZone(tz, code), expected, `mondayOf disagreed under TZ=${tz}`);
  }
});

test('mondayOf of "now" agrees with the database\'s own week', () => {
  // The server buckets the timesheet with mondayOf(new Date()) and then filters
  // a DATE column against it. If the two calendars disagree, the default week
  // is off by one and the user sees somebody else's hours — or none.
  const code = `Promise.all([import('./src/dates.js'), import('./src/db.js')]).then(async ([{mondayOf},{pool}]) => {
    const { rows } = await pool.query("SELECT to_char(date_trunc('week', current_date), 'YYYY-MM-DD') AS monday");
    console.log(mondayOf(new Date()) === rows[0].monday ? 'agree' : 'DISAGREE ' + mondayOf(new Date()) + ' vs ' + rows[0].monday);
    await pool.end();
  });`;
  for (const tz of ZONES) {
    assert.equal(inZone(tz, code), 'agree', `week boundary disagreed with Postgres under TZ=${tz}`);
  }
});

/* ----------------------------------------------------- the DATE type parser */

test('a DATE column arrives as a calendar day, not an instant, in every timezone', () => {
  const code = `import('./src/db.js').then(async ({pool}) => {
    const { rows } = await pool.query("SELECT '2026-06-01'::date AS d");
    console.log(JSON.stringify(rows[0].d)); await pool.end();
  });`;
  for (const tz of ZONES) {
    assert.equal(inZone(tz, code), '"2026-06-01"', `DATE was mangled under TZ=${tz}`);
  }
});

test('a DATE survives JSON serialisation unchanged', () => {
  // .slice(0,10) on the serialised value is what the client and the calendar
  // grid key on, so the round trip through JSON is the thing that matters.
  const code = `import('./src/db.js').then(async ({pool}) => {
    const { rows } = await pool.query("SELECT '2026-06-01'::date AS d");
    console.log(JSON.parse(JSON.stringify(rows[0])).d.slice(0, 10)); await pool.end();
  });`;
  for (const tz of ZONES) {
    assert.equal(inZone(tz, code), '2026-06-01', `DATE slipped a day through JSON under TZ=${tz}`);
  }
});
