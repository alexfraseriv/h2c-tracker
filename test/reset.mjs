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
 *   node test/reset.mjs drill <exec-url> <team-key> --yes      # gun + legs 1-12
 *   node test/reset.mjs drill --dry                            # preview, no network
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

/* ------------------------------------------------------------------ drill */
/* Standard gun is 12:45 PM Pacific. Pick the most recent one far enough back
   that leg 12 has already finished, so the drill reads as a race in progress
   rather than one with finish times in the future. */
function drillGun(rows, fresh) {
  const through12 = rows[11].predEnd - rows[0].predStart;
  // --fresh: place the gun so leg 12 landed ~8 min ago, so leg 13 reads as a
  // runner who just started rather than one out there for most of a day.
  if (fresh) return new Date(Date.now() - through12 - 8 * 60000);
  const parts = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  for (let back = 0; back < 7; back++) {
    const day = parts(new Date(Date.now() - back * 86400000));
    const gun = new Date(day + 'T12:45:00-07:00');
    if (Date.now() - gun >= through12 + 300000) return gun;
  }
  throw new Error('could not place a gun time');
}

/* Deterministic jitter — a drill you can re-run and compare against. */
function rng(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

function drillPlan(fresh) {
  const rows = bakedPlan();
  const gun = drillGun(rows, fresh);
  const rand = rng(20260828);
  const base = +gun - +rows[0].predStart;
  let drift = 0;
  const recs = [];
  for (let i = 0; i < 12; i++) {
    drift += Math.round((rand() * 200 - 70));            // seconds, accumulating
    recs.push({ leg: i + 1, when: new Date(+rows[i].predEnd + base + drift * 1000) });
  }
  // Two dead zones. A van drops service, keeps pressing, and the phone flushes
  // the whole batch when it comes back — the case the app exists for.
  const batches = [
    { phone: 'van 1', legs: [1, 2],        note: 'online' },
    { phone: 'van 1', legs: [3, 4, 5],     note: 'DEAD ZONE — queued, flushed at the Sandy exchange' },
    { phone: 'van 1', legs: [6],           note: 'online' },
    { phone: 'van 2', legs: [7, 8],        note: 'online' },
    { phone: 'van 2', legs: [9, 10, 11],   note: 'DEAD ZONE — queued through the canyon' },
    { phone: 'van 2', legs: [12],          note: 'online' },
  ];
  return { gun, recs, batches, rows };
}

async function drill(url, key, confirmed, dry, fresh) {
  const { gun, recs, batches, rows } = drillPlan(fresh);
  const at = (leg) => recs[leg - 1].when;

  console.log(`\nGun ${pretty(gun)}${fresh ? ' (--fresh: placed so leg 12 just landed)' : ' (standard 12:45 PM start)'}`);
  console.log('Recording legs 1-12, through the second van exchange (OMSI Gravel Lot).\n');
  for (const b of batches) {
    console.log(`  ${b.phone}  legs ${b.legs.join(',').padEnd(8)} ${b.legs.map((l) => pretty(at(l))).join('  ')}`);
    if (b.note !== 'online') console.log(`          ${b.note}`);
  }

  // The plan has to agree with the drill or every delta reads in days. This is
  // the same output as `plan`, anchored to the gun above.
  const delta = gun - rows[0].predStart;
  console.log('\nPaste these into the predicted Start Time / End Time columns at Leg 1');
  console.log('so vs-planned reads in minutes instead of days:\n');
  for (const r of rows) {
    console.log('  ' + sheetStamp(new Date(+r.predStart + delta)) + '\t' + sheetStamp(new Date(+r.predEnd + delta)));
  }

  if (dry) { console.log('\nDry run — nothing sent.'); return; }
  if (!url || !key) { console.log('\nUsage: node test/reset.mjs drill <exec-url> <team-key> --yes'); process.exit(1); }

  const get = async () => (await fetch(`${url}?key=${encodeURIComponent(key)}`, { redirect: 'follow' })).json();
  const post = async (body) => (await fetch(url, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ key, ...body }),
  })).json();

  const before = await get();
  if (!before.ok) throw new Error('read failed: ' + before.error);
  const dirty = before.state.legs.filter((l) => l.actEnd).length;
  if (dirty && !confirmed) {
    console.log(`\n${dirty} leg(s) already recorded. Re-run with --yes to wipe and re-seed.`);
    return;
  }
  if (!confirmed) { console.log('\nDry run against the live sheet. Re-run with --yes to write.'); return; }

  console.log('\nClearing…');
  let r = await post({ clears: before.state.legs.map((l) => l.leg), raceStart: 'CLEAR' });
  if (!r.ok) throw new Error('clear failed: ' + r.error);

  console.log('Setting the gun…');
  r = await post({ raceStart: gun.toISOString() });
  if (!r.ok) throw new Error('race start failed: ' + r.error);

  for (const b of batches) {
    r = await post({ records: b.legs.map((l) => ({ leg: l, endTimeISO: at(l).toISOString() })) });
    if (!r.ok) throw new Error(`batch ${b.legs.join(',')} failed: ` + r.error);
    console.log(`  sent ${b.phone} legs ${b.legs.join(',')}${b.note === 'online' ? '' : '  (flushed after a dead zone)'}`);
  }
  // A phone that timed out on a batch it actually won, retrying — must be idempotent.
  await post({ records: [{ leg: 5, endTimeISO: at(5).toISOString() }] });

  const s = (await get()).state;
  const done = s.legs.filter((l) => l.actEnd).length;
  const wrong = s.legs.slice(0, 12).filter((l, i) => Math.abs(new Date(l.actEnd) - at(i + 1)) > 2000);
  console.log(`\n${done} legs recorded${done === 12 ? '' : ' (expected 12)'}, ${wrong.length} mismatched.`);
  console.log(`Leg 13 (${s.legs[12].runner}) is now the live leg.`);
  if (done !== 12 || wrong.length) process.exit(1);
}

const [, , cmd, ...rest] = process.argv;
if (cmd === 'plan') plan(rest[0]);
else if (cmd === 'clear') await clear(rest[0], rest[1], rest.includes('--yes'));
else if (cmd === 'drill') await drill(rest[0], rest[1], rest.includes('--yes'), rest.includes('--dry'), rest.includes('--fresh'));
else {
  console.log('node test/reset.mjs clear <exec-url> <team-key> [--yes]   clear recorded times + race start');
  console.log('node test/reset.mjs plan  "2026-08-20T17:00"              print a re-anchored planned schedule');
  console.log('node test/reset.mjs drill <exec-url> <team-key> --yes     gun + legs 1-12 with dead zones');
  console.log('node test/reset.mjs drill --dry [--fresh]              preview it without touching anything');
  process.exit(1);
}
