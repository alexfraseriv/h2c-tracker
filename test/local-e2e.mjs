#!/usr/bin/env node
/**
 * Local end-to-end test: runs the REAL Code.gs against a faithful replica of
 * the team's actual spreadsheet (structure + values pulled via Drive export
 * on 2026-08-17). No Google account needed; catches layout/logic bugs before
 * deploy. The one thing it cannot test is Google's own deployment layer —
 * that's what test/simulate.mjs (against the live /exec URL) is for.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok || extra === undefined ? '' : '  → ' + extra));
  ok ? pass++ : fail++;
};

/* ---------------- replica of the real spreadsheet ---------------- */
// Predicted end times exactly as read from the live sheet (Pacific).
const PRED = [ // [leg, runner#, name, miles, predEnd 'M/D H:M:S']
  [1,1,'Matt McFarland',6.26,'8/28 13:50:56'],[2,2,'Anthony Socotch',6.05,'8/28 14:27:14'],
  [3,3,'Taylor Doty',4.08,'8/28 15:01:47'],[4,4,'Lara Geoghegan',6.64,'8/28 16:15:23'],
  [5,5,'Patrick Geoghegan',6.05,'8/28 16:50:28'],[6,6,'Courtney Ratkowiak',7.10,'8/28 17:44:54'],
  [7,7,'Samantha Cox',5.25,'8/28 18:37:19'],[8,8,'TJ Kell',6.00,'8/28 19:23:49'],
  [9,9,'Brian Schaldach',5.38,'8/28 20:09:22'],[10,10,'Trevor Montre',6.15,'8/28 20:55:29'],
  [11,11,'Brian Wehner',3.92,'8/28 21:29:28'],[12,12,'Alex Fraser',5.85,'8/28 22:29:55'],
  [13,1,'Matt McFarland',5.21,'8/28 23:24:47'],[14,2,'Anthony Socotch',7.91,'8/29 00:12:15'],
  [15,3,'Taylor Doty',6.00,'8/29 01:03:03'],[16,4,'Lara Geoghegan',4.00,'8/29 01:47:23'],
  [17,5,'Patrick Geoghegan',5.32,'8/29 02:18:14'],[18,6,'Courtney Ratkowiak',4.15,'8/29 02:50:03'],
  [19,7,'Samantha Cox',5.89,'8/29 03:48:51'],[20,8,'TJ Kell',5.58,'8/29 04:32:06'],
  [21,9,'Brian Schaldach',5.06,'8/29 05:14:57'],[22,10,'Trevor Montre',6.82,'8/29 06:06:06'],
  [23,11,'Brian Wehner',4.16,'8/29 06:42:09'],[24,12,'Alex Fraser',4.83,'8/29 07:32:03'],
  [25,1,'Matt McFarland',3.80,'8/29 08:12:05'],[26,2,'Anthony Socotch',5.65,'8/29 08:45:59'],
  [27,3,'Taylor Doty',6.36,'8/29 09:39:50'],[28,4,'Lara Geoghegan',3.83,'8/29 10:22:17'],
  [29,5,'Patrick Geoghegan',5.97,'8/29 10:56:54'],[30,6,'Courtney Ratkowiak',5.32,'8/29 11:37:42'],
  [31,7,'Samantha Cox',3.96,'8/29 12:17:14'],[32,8,'TJ Kell',4.20,'8/29 12:49:47'],
  [33,9,'Brian Schaldach',7.72,'8/29 13:55:08'],[34,10,'Trevor Montre',4.12,'8/29 14:26:02'],
  [35,11,'Brian Wehner',7.07,'8/29 15:27:19'],[36,12,'Alex Fraser',5.03,'8/29 16:19:17'],
];
const pd = (s) => { // '8/28 13:50:56' → Date in PDT
  const [md, hms] = s.split(' ');
  const [mo, d] = md.split('/').map(Number);
  return new Date(`2026-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}T${hms.padStart(8,'0')}-07:00`);
};
const RACE_START = pd('8/28 12:45:00');

// Header row exactly as it appears in the live tracker tab (col 1 is the
// vertical VAN-ONE/TWO gutter; predicted Start/End at 13/14; actual block at 16+).
// EXACT strings from the live sheet's xlsx export — headers wrap with \n.
const HEADERS = ['', 'Leg\n#', 'Runner\n#', 'Runner', 'Miles', 'Van\nMiles', '',
  'Pace', 'Leg\nTime', 'Elapsed\nVan\nTime', 'Van\nPace', 'Elapsed\nCourse\nTime', 'Start\nTime', 'End\nTime', '',
  'Pace', 'Leg\nTime', 'Elapsed\nVan\nTime', 'Van\nPace', 'Elapsed\nCourse\nTime',
  'Start\nTime\n(DO NOT MODIFY)', 'Finish?\n(CHECK)', 'End\nTime\n(EDIT THESE CELLS)', 'End\nTime\n(DO NOT MODIFY)', '',
  'Indiv', 'Elapsed'];

function trackerGrid(){
  const g = [];
  g.push(Array(27).fill(''));
  const r2 = Array(27).fill(''); r2[1] = 'Race Start:'; r2[3] = new Date(RACE_START); g.push(r2);
  g.push(Array(27).fill(''));
  const r4 = Array(27).fill(''); r4[1] = '[merged] Runners & Legs'; r4[7] = '[merged] Predicted'; r4[15] = '[merged] Actual'; g.push(r4);
  g.push(HEADERS.slice());
  const gutter = { 6:'O', 7:'N', 8:'E', 18:'T', 19:'W', 20:'O' }; // decorative letters in col 1
  PRED.forEach(([leg, rn, name, miles, endS], i) => {
    const row = Array(27).fill('');
    const predStart = i === 0 ? new Date(RACE_START) : pd(PRED[i-1][4]);
    const predEnd = pd(endS);
    if (gutter[5 + i + 1]) row[0] = gutter[5 + i + 1];
    row[1] = leg; row[2] = rn; row[3] = name; row[4] = miles;
    row[12] = predStart; row[13] = predEnd;
    row[20] = new Date(predStart);          // Start Time (DO NOT MODIFY)
    row[21] = false;                        // Finish? (CHECK) — all unchecked, as live
    // Live sheet quirk: the EDIT column already holds stale values (defaults
    // for legs 1–9, drifted leftovers for 10+). Modeled here with +123s drift.
    row[22] = new Date(+predEnd + (leg >= 10 ? 123000 : 0));
    row[23] = new Date(predEnd);            // End Time (DO NOT MODIFY)
    g.push(row);
  });
  return g;
}

/* ---------------- Apps Script service mocks ---------------- */
function mkRange(sheet, r, c, nr = 1, nc = 1){
  const grid = sheet.grid;
  const ensure = (ri, ci) => {
    while (grid.length < ri) grid.push([]);
    const row = grid[ri - 1];
    while (row.length < ci) row.push('');
  };
  return {
    getRow: () => r, getColumn: () => c,
    getValues(){ const out = []; for (let i = 0; i < nr; i++){ const row = grid[r - 1 + i] || []; const o = [];
      for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]); out.push(o); } return out; },
    getValue(){ return this.getValues()[0][0]; },
    setValues(v){ for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++){ ensure(r + i, c + j); grid[r - 1 + i][c - 1 + j] = v[i][j]; } return this; },
    setValue(v){ ensure(r, c); grid[r - 1][c - 1] = v; return this; },
    clearContent(){ for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++){ ensure(r + i, c + j); grid[r - 1 + i][c - 1 + j] = ''; } return this; },
  };
}
function mkSheet(name, grid){
  const sheet = { name, grid };
  sheet.getName = () => name;
  sheet.getLastColumn = () => Math.max(1, ...grid.map(r => r.length));
  sheet.getRange = (r, c, nr, nc) => mkRange(sheet, r, c, nr, nc);
  sheet.setFrozenRows = () => {};
  sheet.getDataRange = () => mkRange(sheet, 1, 1, grid.length, sheet.getLastColumn());
  sheet.createTextFinder = (text) => ({
    matchEntireCell(){ return this; },
    findNext(){
      for (let i = 0; i < grid.length; i++) for (let j = 0; j < (grid[i] || []).length; j++)
        if (typeof grid[i][j] === 'string' && grid[i][j].trim() === text) return mkRange(sheet, i + 1, j + 1);
      return null;
    },
  });
  return sheet;
}
function mkWorld(){
  const sheets = [
    mkSheet('Trip Logistics', [['Name','Van','Runner'], ['Matt', 1, 1]]),
    mkSheet('Packing List', [['H2C Packing List'], ['Headlamp']]),
    mkSheet('Exchange Schedule', [['', 'Handoff', 'Estimated Time @ Handoff'], ['Start', 'Van 1', new Date(RACE_START)]]),
    mkSheet('Pace Math', [['[merged] Edit Cells', 'Runner Name', 'Pace'], ['', 'Matt', '10:32']]),
    mkSheet('Time Tracker', trackerGrid()),
  ];
  const ss = {
    getSpreadsheetTimeZone: () => 'America/Los_Angeles',
    getSheets: () => sheets,
    getSheetByName: (n) => sheets.find(s => s.name === n) || null,
    insertSheet: (n) => { const s = mkSheet(n, [[]]); sheets.push(s); return s; },
  };
  const caches = new Map(), props = new Map();
  const env = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, flush: () => {} },
    CacheService: { getScriptCache: () => ({
      get: (k) => caches.has(k) ? caches.get(k) : null,
      put: (k, v) => caches.set(k, v),
      remove: (k) => caches.delete(k) }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => props.has(k) ? props.get(k) : null,
      setProperty: (k, v) => props.set(k, v),
      deleteProperty: (k) => props.delete(k) }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    ContentService: { MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ content: s, setMimeType(){ return this; } }) },
    Session: { getScriptTimeZone: () => 'America/Los_Angeles' },
    Logger: { log: (...a) => console.log('    [gas]', ...a.map(x => typeof x === 'string' ? x : JSON.stringify(x))) },
  };
  return { ss, env };
}

/* ---------------- load the real Code.gs ---------------- */
const src = readFileSync(join(here, '..', 'Code.gs'), 'utf8');
const { ss, env } = mkWorld();
const gas = new Function(...Object.keys(env),
  src + '\n;return { doGet, doPost, verifySetup, smokeTest };')(...Object.values(env));

const KEY = 'seaside-or-bust-2026';
const GET = (key = KEY) => JSON.parse(gas.doGet({ parameter: { key } }).content);
const POST = (body) => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(Object.assign({ key: KEY }, body)) } }).content);

/* ---------------- tests ---------------- */
console.log('— Layout detection on the real structure —');
gas.verifySetup();
let r = GET();
check('doGet ok', r.ok === true, r.error);
check('36 legs', r.state.legs.length === 36);
check('runner names match roster', r.state.legs[0].runner === 'Matt McFarland' &&
  r.state.legs[8].runner === 'Brian Schaldach' && r.state.legs[35].runner === 'Alex Fraser');
check('runner numbers read from the Runner # column', r.state.legs[0].runnerNum === 1 &&
  r.state.legs[18].runnerNum === 7 && r.state.legs[35].runnerNum === 12);
check('miles match', r.state.legs[0].miles === 6.26 && r.state.legs[35].miles === 5.03);
check('pred times are real datetimes', r.state.legs[0].predEnd === pd('8/28 13:50:56').toISOString() &&
  r.state.legs[13].predEnd === pd('8/29 00:12:15').toISOString());
check('REGRESSION: stale values in EDIT column ignored while unchecked',
  r.state.legs.every(l => l.actEnd === null && l.done === false));
check('bad key rejected', GET('wrong').ok === false);

console.log('— Baked fallback in index.html matches the live sheet —');
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const baked = [...html.matchAll(/\[(\d+),(\d+),([\d.]+),'([^']+)'\]/g)]
  .map(m => ({ leg: +m[1], runner: +m[2], miles: +m[3], end: new Date(m[4]) }));
check('36 baked legs parsed', baked.length === 36);
check('baked end times equal live predicted', baked.every((b, i) => +b.end === +pd(PRED[i][4])));
check('baked miles + runner numbers equal live', baked.every((b, i) => b.miles === PRED[i][3] && b.runner === PRED[i][1]));

console.log('— Write path: record, clear, race start —');
const t1 = '2026-08-28T20:53:00.000Z', t2 = '2026-08-28T21:31:00.000Z';
r = POST({ records: [{ leg: 1, endTimeISO: t1 }, { leg: 2, endTimeISO: t2 }], raceStart: '2026-08-28T19:47:00.000Z' });
check('batch ok', r.ok === true, r.error);
check('legs 1+2 now done with our times', r.state.legs[0].actEnd === t1 && r.state.legs[1].actEnd === t2 &&
  r.state.legs[0].done === true);
check('leg 3 still untouched despite stale edit value', r.state.legs[2].actEnd === null);
check('race start stored (not in the sheet)', r.state.raceStartActual === '2026-08-28T19:47:00.000Z');
const tr = ss.getSheetByName('Time Tracker');
check('checkbox ticked in the sheet', tr.getRange(6, 22).getValue() === true);
check('edit cell holds our Date', +tr.getRange(6, 23).getValue() === +new Date(t1));

r = POST({ clears: [2] });
check('clear works', r.ok && r.state.legs[1].actEnd === null && tr.getRange(7, 22).getValue() === false);
check('leg 1 survives the clear of leg 2', r.state.legs[0].actEnd === t1);

r = POST({ raceStart: 'CLEAR' });
check('race start clears', r.ok && r.state.raceStartActual === null);

console.log('— Kills → separate App Kills tab —');
r = POST({ kills: [{ leg: 3, kills: 7 }, { leg: 19, kills: 12 }] });
check('kills stored + returned', r.ok && r.state.kills['3'] === 7 && r.state.kills['19'] === 12);
r = POST({ kills: [{ leg: 3, kills: 9 }] });
check('kills overwrite (correction)', r.ok && r.state.kills['3'] === 9);
const ks = ss.getSheetByName('App Kills');
check('App Kills tab created with header + rows at leg+1', !!ks &&
  ks.getRange(1, 1).getValue() === 'Leg' && ks.getRange(4, 2).getValue() === 9 && ks.getRange(20, 2).getValue() === 12);
check('tracker tab untouched by kills', tr.getRange(8, 22).getValue() === false);

console.log('— Failure behavior —');
r = POST({ records: [{ leg: 4, endTimeISO: '2026-08-28T23:00:00.000Z' }, { leg: 99, endTimeISO: t1 }] });
check('bad leg in batch → ok:false with message', r.ok === false && /Bad leg/.test(r.error));
r = GET();
check('earlier record in failed batch did apply (client retry is idempotent, so safe)',
  r.state.legs[3].actEnd === '2026-08-28T23:00:00.000Z');
check('doPost without key rejected', POST({ key: 'nope', records: [] }).ok === false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
