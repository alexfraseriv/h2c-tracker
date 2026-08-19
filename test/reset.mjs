#!/usr/bin/env node
/**
 * H2C tracker — reset the sheet for a drill.
 *
 * Two jobs, deliberately separate because only one of them can touch the
 * backend:
 *
 *   1. CLEAR the recorded times. The deployed Apps Script can do this, so this
 *      script does it over the wire.
 *
 *   2. RE-ANCHOR the planned schedule. The deployed script has no endpoint for
 *      writing the predicted block, so this only PRINTS paste-ready columns.
 *      Every leg keeps its exact planned duration; the whole plan just moves.
 *
 * Usage:
 *   node test/reset.mjs clear <exec-url> <team-key> --yes
 *   node test/reset.mjs clear <exec-url> <team-key>            # dry run
 *   node test/reset.mjs plan  "2026-08-20T17:00"               # local Pacific
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const TZ = 'America/Los_Angeles';
const LEGS = 36;

/* The planned durations come from the baked schedule in index.html, which
   test/local-e2e.mjs asserts is identical to the live sheet. */
function bakedPlan() {
  const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
  const start = html.match(/RACE_PLANNED_BAKED = '([^']+)'/)[1];
  const rows = [...html.matchAll(/\[(\d+),(\d+),([\d.]+),'([^']+)'\]/g)]
    .map((m) => ({ leg: +m[1], end: new Date(m[4]) }));
  if (rows.length !== LEGS) throw new Error('expected 36 baked legs, found ' + rows.length);
  return rows.map((r, i) => ({
    leg: r.leg,
    predStart: i === 0 ? new Date(start) : rows[i - 1].end,
    predEnd: r.end,
  }));
}

const sheetStamp = (d) => {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.month}/${p.day}/${p.year} ${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
};
const pretty = (d) => new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
}).format(d);

/* ------------------------------------------------------------------ plan */
function plan(anchorLocal) {
  if (!anchorLocal) {
    console.log('Usage: node test/reset.mjs plan "2026-08-20T17:00"   (Pacific wall clock)');
    process.exit(1);
  }
  const target = new Date(anchorLocal.length === 16 ? anchorLocal + ':00-07:00' : anchorLocal);
  if (isNaN(target)) throw new Error('could not parse "' + anchorLocal + '"');

  const rows = bakedPlan();
  const delta = target - rows[0].predStart;
  const shift = (d) => new Date(+d + delta);
  const hrs = (rows[35].predEnd - rows[0].predStart) / 3600000;

  console.error(`\nPlanned start moves ${pretty(rows[0].predStart)} -> ${pretty(target)}`);
  console.error(`Race spans ${hrs.toFixed(1)}h, finishing ${pretty(shift(rows[35].predEnd))}`);
  console.error(`Every leg keeps its planned duration.\n`);
  console.error('Paste the two columns below into the PREDICTED block — the columns');
  console.error('headed "Start Time" and "End Time" — on the row where Leg # = 1.');
  console.error('If "Start Time (DO NOT MODIFY)" mirrors the planned start, paste');
  console.error('column 1 there too. Recorded times and the roster are untouched.\n');

  for (const r of rows) console.log(sheetStamp(shift(r.predStart)) + '\t' + sheetStamp(shift(r.predEnd)));
}

/* ----------------------------------------------------------------- clear */
async function clear(url, key, confirmed) {
  if (!url || !key) {
    console.log('Usage: node test/reset.mjs clear <exec-url> <team-key> --yes');
    process.exit(1);
  }
  const get = async () => (await fetch(`${url}?key=${encodeURIComponent(key)}`, { redirect: 'follow' })).json();
  const post = async (body) => (await fetch(url, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ key, ...body }),
  })).json();

  const before = await get();
  if (!before.ok) throw new Error('read failed: ' + before.error);
  const recorded = before.state.legs.filter((l) => l.actEnd);
  console.log(`\n${recorded.length} recorded leg(s), race start ${before.state.raceStartActual ? 'SET' : 'not set'}`);
  for (const l of recorded) console.log(`  leg ${String(l.leg).padStart(2)}  ${l.runner.padEnd(20)} ${pretty(new Date(l.actEnd))}`);

  if (!recorded.length && !before.state.raceStartActual) { console.log('\nNothing to clear.'); return; }
  if (!confirmed) { console.log('\nDry run. Re-run with --yes to clear the above.'); return; }

  const res = await post({ clears: before.state.legs.map((l) => l.leg), raceStart: 'CLEAR' });
  if (!res.ok) throw new Error('clear failed: ' + res.error);
  const left = res.state.legs.filter((l) => l.actEnd);
  console.log(`\nCleared. ${left.length} recorded leg(s) remain, race start ${res.state.raceStartActual ? 'STILL SET' : 'cleared'}.`);
  if (left.length) { console.log('Legs that did not clear:', left.map((l) => l.leg).join(', ')); process.exit(1); }
}

const [, , cmd, ...rest] = process.argv;
if (cmd === 'plan') plan(rest[0]);
else if (cmd === 'clear') await clear(rest[0], rest[1], rest.includes('--yes'));
else {
  console.log('node test/reset.mjs clear <exec-url> <team-key> [--yes]   clear recorded times + race start');
  console.log('node test/reset.mjs plan  "2026-08-20T17:00"              print a re-anchored planned schedule');
  process.exit(1);
}
