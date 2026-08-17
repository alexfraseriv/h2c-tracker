#!/usr/bin/env node
/**
 * THE GAUNTLET — adversarial + performance testing.
 * Boots the REAL client (index.html's script, DOM shimmed) against the REAL
 * backend (Code.gs, GAS services mocked) with a chaos-mode network in between.
 * Simulates: dead zones, dropped responses, dueling phones, corrupted storage,
 * private browsing, misconfigured deploys, hung requests, hostile sheet edits,
 * clock skew, and measures hot-path performance.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok || extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
  ok ? pass++ : fail++;
};
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

/* ================= GAS world (replica of the live sheet) ================= */
const PRED = [
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
const pd = (s) => {
  const [md, hms] = s.split(' ');
  const [mo, d] = md.split('/').map(Number);
  return new Date(`2026-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}T${hms.padStart(8,'0')}-07:00`);
};
const RACE_START = pd('8/28 12:45:00');
const HEADERS = ['', 'Leg #', 'Runner #', 'Runner', 'Miles', 'Van Miles', '',
  'Pace', 'Leg Time', 'Elapsed Van Time', 'Van Pace', 'Elapsed Course Time', 'Start Time', 'End Time', '',
  'Pace', 'Leg Time', 'Elapsed Van Time', 'Van Pace', 'Elapsed Course Time',
  'Start Time (DO NOT MODIFY)', 'Finish? (CHECK)', 'End Time (EDIT THESE CELLS)', 'End Time (DO NOT MODIFY)', '',
  'Indiv', 'Elapsed'];
function trackerGrid(){
  const g = [Array(27).fill('')];
  const r2 = Array(27).fill(''); r2[1] = 'Race Start:'; r2[3] = new Date(RACE_START); g.push(r2);
  g.push(Array(27).fill(''));
  const r4 = Array(27).fill(''); r4[7] = '[merged] Predicted'; r4[15] = '[merged] Actual'; g.push(r4);
  g.push(HEADERS.slice());
  PRED.forEach(([leg, rn, name, miles, endS], i) => {
    const row = Array(27).fill('');
    const predStart = i === 0 ? new Date(RACE_START) : pd(PRED[i-1][4]);
    const predEnd = pd(endS);
    row[1] = leg; row[2] = rn; row[3] = name; row[4] = miles;
    row[12] = predStart; row[13] = predEnd;
    row[20] = new Date(predStart); row[21] = false;
    row[22] = new Date(+predEnd + (leg >= 10 ? 123000 : 0)); // stale edit values, as live
    row[23] = new Date(predEnd);
    g.push(row);
  });
  return g;
}
function mkRange(sheet, r, c, nr = 1, nc = 1){
  const grid = sheet.grid;
  const ensure = (ri, ci) => { while (grid.length < ri) grid.push([]); const row = grid[ri-1]; while (row.length < ci) row.push(''); };
  return {
    getRow: () => r, getColumn: () => c,
    getValues(){ const out = []; for (let i = 0; i < nr; i++){ const row = grid[r-1+i] || []; const o = [];
      for (let j = 0; j < nc; j++) o.push(row[c-1+j] === undefined ? '' : row[c-1+j]); out.push(o); } return out; },
    getValue(){ return this.getValues()[0][0]; },
    setValues(v){ for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++){ ensure(r+i, c+j); grid[r-1+i][c-1+j] = v[i][j]; } return this; },
    setValue(v){ ensure(r, c); grid[r-1][c-1] = v; return this; },
    clearContent(){ for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++){ ensure(r+i, c+j); grid[r-1+i][c-1+j] = ''; } return this; },
  };
}
function mkSheet(name, grid){
  const sheet = { name, grid };
  sheet.getName = () => name;
  sheet.getLastColumn = () => Math.max(1, ...grid.map(r => r.length));
  sheet.getRange = (r, c, nr, nc) => mkRange(sheet, r, c, nr, nc);
  sheet.setFrozenRows = () => {};
  sheet.getDataRange = () => mkRange(sheet, 1, 1, grid.length, sheet.getLastColumn());
  sheet.createTextFinder = (text) => ({ matchEntireCell(){ return this; },
    findNext(){ for (let i = 0; i < grid.length; i++) for (let j = 0; j < (grid[i]||[]).length; j++)
      if (typeof grid[i][j] === 'string' && grid[i][j].trim() === text) return mkRange(sheet, i+1, j+1);
      return null; } });
  return sheet;
}
function mkGasWorld(){
  const sheets = [
    mkSheet('Trip Logistics', [['Name','Van','Runner']]),
    mkSheet('Exchange Schedule', [['', 'Handoff', 'Estimated Time @ Handoff']]),
    mkSheet('Time Tracker', trackerGrid()),
  ];
  const ss = { getSpreadsheetTimeZone: () => 'America/Los_Angeles',
    getSheets: () => sheets, getSheetByName: (n) => sheets.find(s => s.name === n) || null,
    insertSheet: (n) => { const s = mkSheet(n, [[]]); sheets.push(s); return s; } };
  const caches = new Map(), props = new Map();
  const env = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, flush: () => {} },
    // State cache disabled here: the real one expires in 15s, but the gauntlet
    // runs in milliseconds — a never-expiring mock would be LESS faithful.
    // Cache invalidation semantics are covered in local-e2e.mjs.
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: k => caches.delete(k) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.has(k) ? props.get(k) : null,
      setProperty: (k,v) => props.set(k,v), deleteProperty: k => props.delete(k) }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ content: s, setMimeType(){ return this; } }) },
    Session: { getScriptTimeZone: () => 'America/Los_Angeles' },
    Logger: { log: () => {} },
  };
  const src = readFileSync(join(here, '..', 'Code.gs'), 'utf8');
  const gas = new Function(...Object.keys(env), src + '\n;return { doGet, doPost };')(...Object.values(env));
  return { gas, ss, tracker: () => ss.getSheetByName('Time Tracker') };
}

/* ================= headless client ================= */
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
let clientSrc = html.match(/<script>([\s\S]*)<\/script>/)[1]
  .replace("SCRIPT_URL: ''", "SCRIPT_URL: 'https://mock.local/exec'")
  .replace('POLL_SEC: 60', 'POLL_SEC: 1e9');   // keep perf ticks pure render

class El {
  constructor(id){ this.id = id; this.innerHTML = ''; this.textContent = ''; this.value = '';
    this.style = {}; this.dataset = {}; this.attrs = {}; this.disabled = false; this.hidden = false; this.open = false;
    this._cls = new Set(); this._h = {};
    const cls = this._cls;
    this.classList = { add: (...c) => c.forEach(x => cls.add(x)), remove: (...c) => c.forEach(x => cls.delete(x)),
      toggle: (c, f) => { (f === undefined ? !cls.has(c) : f) ? cls.add(c) : cls.delete(c); }, contains: c => cls.has(c) }; }
  addEventListener(t, fn){ (this._h[t] = this._h[t] || []).push(fn); }
  setAttribute(k, v){ this.attrs[k] = String(v); }
  getAttribute(k){ return this.attrs[k] ?? null; }
  scrollIntoView(){} showModal(){ this.open = true; } close(){ this.open = false; }
  fire(t, ev){ (this._h[t] || []).slice().forEach(fn => fn(ev || { target: { closest: () => null } })); }
}
function makeClient(gasWorld, opts = {}){
  const els = new Map();
  const byId = id => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); };
  const segButtons = [0, 1, 2].map(v => { const e = new El('seg' + v); e.dataset.van = String(v); return e; });
  const doc = { getElementById: byId, querySelector: sel => byId('SEL:' + sel),
    querySelectorAll: sel => sel === '.seg button' ? segButtons : [],
    _h: {}, addEventListener(t, fn){ (this._h[t] = this._h[t] || []).push(fn); }, visibilityState: 'visible' };
  const win = { _h: {}, addEventListener(t, fn){ (this._h[t] = this._h[t] || []).push(fn); },
    fire(t){ (this._h[t] || []).forEach(fn => fn()); } };
  const store = { data: opts.seedStorage ? { ...opts.seedStorage } : {},
    getItem(k){ return k in this.data ? this.data[k] : null; },
    setItem(k, v){ if (opts.brokenStorage) throw new Error('QuotaExceededError'); this.data[k] = String(v); } };
  const navigator = { onLine: true, vibrate(){} };
  const timers = { seq: 1, timeouts: [], intervals: [] };
  const setTimeout_ = (fn, ms) => { const id = timers.seq++; timers.timeouts.push({ id, fn, ms }); return id; };
  const clearTimeout_ = id => { timers.timeouts = timers.timeouts.filter(t => t.id !== id); };
  const setInterval_ = (fn, ms) => { const id = timers.seq++; timers.intervals.push({ id, fn, ms }); return id; };
  const clearInterval_ = id => { timers.intervals = timers.intervals.filter(t => t.id !== id); };
  const net = { mode: 'ok', calls: [], hung: [] };
  const fetch_ = (url, o = {}) => new Promise((resolve, reject) => {
    net.calls.push({ method: o.method || 'GET', body: o.body || null });
    const run = () => {
      if (net.mode === 'down') return reject(new TypeError('Failed to fetch'));
      if (net.mode === 'html') return resolve({ json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); } });
      const out = o.method === 'POST'
        ? gasWorld.gas.doPost({ postData: { contents: o.body } })
        : gasWorld.gas.doGet({ parameter: { key: decodeURIComponent(String(url).split('key=')[1] || '') } });
      if (net.mode === 'drop-response') return reject(new TypeError('The network connection was lost'));
      resolve({ json: async () => JSON.parse(out.content) });
    };
    if (net.mode === 'hang'){
      if (o.signal) o.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
      net.hung.push(run);
      return;
    }
    queueMicrotask(run);
  });
  const boot = new Function('document', 'window', 'navigator', 'location', 'localStorage',
    'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'AbortController', clientSrc);
  boot(doc, win, navigator, { protocol: 'http:' }, store, fetch_, setTimeout_, clearTimeout_, setInterval_, clearInterval_, AbortController);
  const api = {
    byId, net, store, navigator, win, timers,
    text: id => byId(id).textContent, html: id => byId(id).innerHTML,
    press: async (id) => { byId(id).fire('click'); await settle(); },
    confirm: async () => { byId('confirmGo').fire('click'); await settle(); },
    tapLeg: async (leg) => { byId('timeline').fire('click', { target: { closest: s => s === '.rowmain' ? { dataset: { leg: String(leg) } } : null } }); await settle(); },
    tapKill: async (leg) => { byId('timeline').fire('click', { target: { closest: s => s === '.killbtn' ? { dataset: { leg: String(leg) } } : null } }); await settle(); },
    unlock: async (leg) => { byId('dlgLock').fire('click', { target: { closest: s => s === '#dlgUnlock' ? {} : null } }); await settle(); },
    saveTime: async (hms) => { byId('dlgTime').value = hms; byId('dlgSave').fire('click'); await settle(); },
    online: async (on) => { navigator.onLine = on; if (on) win.fire('online'); await settle(); },
    fireTimeout: async (pred) => { const t = timers.timeouts.find(pred || (() => true));
      if (!t) return false; timers.timeouts = timers.timeouts.filter(x => x !== t); t.fn(); await settle(); return t.ms; },
    releaseHung: async () => { const h = net.hung.splice(0); h.forEach(fn => fn()); await settle(); },
    queue: () => JSON.parse(store.data['h2c2_queue'] || '[]'),
  };
  return api;
}
const trackerCell = (w, leg, col) => w.tracker().getRange(5 + leg, col).getValue();
// Gauntlet presses stamp TODAY's date (that's correct behavior); assert wall-clock time only.
const pdtHMS = d => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit',
  second: '2-digit', hour12: false, timeZone: 'America/Los_Angeles' }).format(new Date(d));

/* ==================================================================== */
console.log('— S1 · Boot + gun + two clean handoffs (baseline) —');
const W = mkGasWorld();
const A = makeClient(W);
await settle(12);
check('boot GET pulled live sheet', A.text('syncText') === 'Live · synced', A.text('syncText'));
await A.press('plunger'); await A.confirm();                       // gun
await A.press('plunger'); await A.confirm();                       // leg 1
await A.press('plunger'); await A.confirm();                       // leg 2
check('legs 1–2 checked in sheet', trackerCell(W, 1, 22) === true && trackerCell(W, 2, 22) === true);
check('race start stored', !!W.gas.doGet && JSON.parse(W.gas.doGet({ parameter: { key: 'seaside-or-bust-2026' } }).content).state.raceStartActual !== null);
check('pill green after burst', A.text('syncText') === 'Live · synced', A.text('syncText'));

console.log('— S2 · Dead zone: 3 presses + 1 correction + kills queued offline, one batch on reconnect —');
await A.online(false);
const callsBefore = A.net.calls.length;
await A.press('plunger'); await A.confirm();                       // leg 3
await A.press('plunger'); await A.confirm();                       // leg 4
await A.press('plunger'); await A.confirm();                       // leg 5
await A.tapLeg(3); await A.saveTime('15:05:00');                   // correct leg 3
await A.tapKill(4);                                                // chase button on done leg 4
for (let i = 0; i < 7; i++) A.byId('killPlus').fire('click');
await A.press('killSave');
check('offline: nothing sent', A.net.calls.length === callsBefore);
check('offline: 4 ops queued (correction replaced leg-3 record)', A.queue().length === 4, A.queue().map(q => q.kind));
check('offline pill', /Offline · 4 queued/.test(A.text('syncText')), A.text('syncText'));
await A.online(true);
const batch = JSON.parse(A.net.calls[A.net.calls.length - 1].body);
check('ONE batch: 3 records + 1 kills', A.net.calls.length === callsBefore + 1 &&
  batch.records.length === 3 && batch.kills.length === 1 && batch.kills[0].kills === 7);
check('correction won: leg 3 = 15:05:00 PDT in sheet', pdtHMS(trackerCell(W, 3, 23)) === '15:05:00', pdtHMS(trackerCell(W, 3, 23)));
check('kills landed in App Kills tab', W.ss.getSheetByName('App Kills').getRange(5, 2).getValue() === 7);
check('queue drained', A.queue().length === 0 && A.text('syncText') === 'Live · synced');

console.log('— S3 · Response dropped after server applied (the classic) —');
A.net.mode = 'drop-response';
await A.press('plunger'); await A.confirm();                       // leg 6 — server applies, response dies
check('server DID apply leg 6', trackerCell(W, 6, 22) === true);
check('client thinks it failed, op still queued', A.queue().length === 1 && /not logged/.test(A.text('syncText')), A.text('syncText'));
A.net.mode = 'ok';
const backoff1 = await A.fireTimeout(t => t.ms >= 10000);          // the scheduled retry
check('retry scheduled at 10s backoff', backoff1 === 10000, backoff1);
check('idempotent resend converged: synced, no dupes, right value', A.queue().length === 0 &&
  /Confirmed in sheet/.test(A.html('histList')) && trackerCell(W, 6, 22) === true);

console.log('— S4 · Captive-portal hell: online but every request dies; backoff must cap —');
A.net.mode = 'down';
await A.press('plunger'); await A.confirm();                       // leg 7 press
const delays = [];
for (let i = 0; i < 6; i++){ const d = await A.fireTimeout(t => t.ms >= 10000); if (d) delays.push(d); }
check('exponential backoff 10→120s, capped', JSON.stringify(delays) === JSON.stringify([10000, 20000, 40000, 80000, 120000, 120000]), delays);
check('op never lost while failing', A.queue().length === 1);
A.net.mode = 'ok';
await A.fireTimeout(t => t.ms >= 10000);
check('recovers when network returns', A.queue().length === 0 && trackerCell(W, 7, 22) === true);

console.log('— S5 · Edit lands while a sync is in flight —');
A.net.mode = 'hang';
await A.press('plunger'); await A.confirm();                       // leg 8 → sync hangs holding it
await A.tapLeg(8); await A.saveTime('19:30:00');                   // new value mid-flight
check('newer op queued while in flight', A.queue().some(q => q.leg === 8));
A.net.mode = 'ok';
await A.releaseHung();                                             // first request completes with OLD value
const drain = await A.fireTimeout(t => t.ms === 250);
check('drainer scheduled and sent the newer edit', drain === 250 && A.queue().length === 0);
check('final sheet value = the NEWER edit', pdtHMS(trackerCell(W, 8, 23)) === '19:30:00', pdtHMS(trackerCell(W, 8, 23)));

console.log('— S6 · Two phones, one leg: last write wins, both converge —');
const B = makeClient(W);
await settle(12);
check('phone B boots into current race state (legs 1–8 done)', /✓/.test(B.html('timeline')));
await B.tapLeg(9); await B.saveTime('20:10:00');                   // B records leg 9
await A.tapLeg(9); await A.saveTime('20:12:30');                   // A corrects it after
check('sheet holds the last arrival (A)', pdtHMS(trackerCell(W, 9, 23)) === '20:12:30', pdtHMS(trackerCell(W, 9, 23)));
await B.online(true);                                              // B polls
check('B converged to A\'s value', /8:12.PM/.test(B.html('timeline')));

console.log('— S7 · Stale phone crawls back and stomps a correction (documented trade-off) —');
await B.online(false);
await B.tapLeg(9); await B.saveTime('20:11:00');                   // B, offline, re-edits leg 9
await A.tapLeg(9); await A.saveTime('20:13:00');                   // A corrects meanwhile
await B.online(true);                                              // B's stale write arrives last…
check('stale write wins (known LWW trade-off)', pdtHMS(trackerCell(W, 9, 23)) === '20:11:00', pdtHMS(trackerCell(W, 9, 23)));
await A.online(true);
check('…but A converges and can see it to re-fix', /8:11.PM/.test(A.html('timeline')));

console.log('— S8 · Poison pill in the queue (corrupted storage) —');
const seeded = { 'h2c2_queue': JSON.stringify([
  { id: 'bad1', kind: 'record', leg: 99, whenISO: '2026-08-28T20:00:00Z', ts: 1 },
  { id: 'bad2', kind: 'record', leg: 10, whenISO: 'garbage', ts: 2 },
  { id: 'ok1',  kind: 'record', leg: 10, whenISO: '2026-08-29T03:57:00.000Z', ts: 3 } ]) };
const C = makeClient(W, { seedStorage: seeded });
await settle(12);
check('invalid ops dropped, valid op synced', C.queue().length === 0 && trackerCell(W, 10, 22) === true);
check('no infinite failure loop', C.text('syncText') === 'Live · synced', C.text('syncText'));

console.log('— S9 · Misconfigured deploy returns a login page —');
C.net.mode = 'html';
await C.tapLeg(11); await C.saveTime('21:31:00');
check('actionable error, not "Unexpected token"', /redeploy the Apps Script/.test(C.text('histErr')), C.text('histErr'));
C.net.mode = 'ok';
await C.fireTimeout(t => t.ms >= 10000);
check('recovers after fix', C.queue().length === 0 && trackerCell(W, 11, 22) === true);

console.log('— S10 · Hung request: 30s timeout aborts, retries, nothing lost —');
C.net.mode = 'hang';
await C.tapLeg(12); await C.saveTime('22:32:00');
const abortMs = await C.fireTimeout(t => t.ms === 30000);          // the AbortController fuse
check('30s abort fuse fired', abortMs === 30000);
check('slow-sheet message, op preserved', /slow to respond/.test(C.text('histErr')) && C.queue().length === 1, C.text('histErr'));
C.net.mode = 'ok'; C.net.hung.length = 0;
await C.fireTimeout(t => t.ms >= 10000);
check('recovered after timeout', C.queue().length === 0 && trackerCell(W, 12, 22) === true);

console.log('— S11 · Private browsing (storage writes throw) —');
const P = makeClient(W, { brokenStorage: true });
await settle(12);
await P.tapLeg(13); await P.saveTime('23:26:00');
check('app functions in-memory, write reached sheet', trackerCell(W, 13, 22) === true);
check('no crash, pill sane', P.text('syncText') === 'Live · synced', P.text('syncText'));

console.log('— S12 · Hostile sheet edits —');
// XSS via runner rename
W.tracker().getRange(5 + 14, 4).setValue('<img src=x onerror=alert(1)> Jones');
await A.online(true);
check('hostile runner name escaped in timeline', A.html('timeline').includes('&lt;img') && !/<img src=x/.test(A.html('timeline')));
W.tracker().getRange(5 + 14, 4).setValue('Anthony Socotch');
// Row inserted mid-table by a helpful teammate
W.tracker().grid.splice(25, 0, Array(27).fill(''));                // blank row after leg 20
const rowResp = JSON.parse(W.gas.doPost({ postData: { contents: JSON.stringify({
  key: 'seaside-or-bust-2026', records: [{ leg: 21, endTimeISO: '2026-08-29T12:16:00.000Z' }] }) } }).content);
check('write still lands on the RIGHT leg after row insert', rowResp.ok === true &&
  W.tracker().grid[26][1] === 21 && W.tracker().grid[26][21] === true);
W.tracker().grid.splice(25, 1);                                    // restore
// Renamed marker header → clear error, no silent wrong-cell writes
const savedHeader = W.tracker().grid[4][22];
W.tracker().grid[4][22] = 'End Time (renamed by accident)';
const wCold = mkGasWorld(); wCold.tracker().grid[4][22] = 'End Time (renamed by accident)';
const renResp = JSON.parse(wCold.gas.doGet({ parameter: { key: 'seaside-or-bust-2026' } }).content);
check('renamed header → explicit error, not silent misfire', renResp.ok === false && /No tab contains/.test(renResp.error));
W.tracker().grid[4][22] = savedHeader;

console.log('— S13 · Clock skew: out-of-order actuals don\'t crash anything —');
await A.tapLeg(14); await A.saveTime('23:20:00');                  // leg 14 BEFORE leg 13's end
check('model + render survive out-of-order times', A.html('timeline').length > 1000 && A.text('raceClock').length > 0);

console.log('— S14 · Malformed server state → baked fallback, no crash —');
const M = makeClient(W, { seedStorage: { 'h2c2_sheet': JSON.stringify([{ leg: 1 }, { leg: 2 }]) } });
await settle(2);
check('boots despite corrupted cached sheet', M.text('raceClock').length > 0);

console.log('— S15 · Kills entry: chase button, slider, prefill, gating, separation —');
check('chase buttons only on done legs', (A.html('timeline').match(/class="killbtn"/g) || []).length ===
  (A.html('timeline').match(/legrow van\d done/g) || []).length);
check('lobster chase on every done leg, no gorilla', /\u{1F99E}/u.test(A.html('timeline')) && !/\u{1F98D}/u.test(A.html('timeline')));
await A.tapKill(5);                                  // completed leg → kills dialog
check('kills dialog opens with kills visible, time editor hidden',
  A.byId('dlgKills').hidden === false && A.byId('dlgTimeWrap').hidden === true);
A.byId('killSlider').value = '23';
A.byId('killSlider').fire('input');
check('slider drag updates the big number', String(A.text('killVal')) === '23', A.text('killVal'));
await A.press('killSave');
check('slider-entered kills reach the App Kills tab', W.ss.getSheetByName('App Kills').getRange(6, 2).getValue() === 23);
await A.tapKill(5);
check('reopening shows the saved count', String(A.text('killVal')) === '23', A.text('killVal'));
A.byId('dlgClose2').fire('click');
await A.tapLeg(5);                                   // TIME dialog on same leg: no kills UI
check('time dialog no longer contains kills entry', A.byId('dlgKills').hidden === true && A.byId('dlgTimeWrap').hidden === false);
A.byId('dlgCancel').fire('click');

console.log('— S16 · Stale offline phone: escape hatch records a "future" leg —');
await A.online(false);
await A.tapLeg(20);                                  // locally future (current is ~15)
check('locked with escape hatch offered', A.byId('dlgLock').hidden === false && /Record it anyway/.test(A.html('SEL:#nope') + A.byId('dlgLock').innerHTML));
await A.unlock(20);
check('hatch unlocks the time editor', A.byId('dlgTimeWrap').hidden === false && A.byId('dlgLock').hidden === true);
await A.saveTime('11:30:00');
check('record queued for the REAL leg (20), not the local current', A.queue().some(q => q.leg === 20));
await A.online(true);
check('lands on leg 20 in the sheet', trackerCell(W, 20, 22) === true && pdtHMS(trackerCell(W, 20, 23)) === '11:30:00');
check('names show runner numbers, legs show L#', /\(R7\)/.test(A.html('timeline')) && />L7</.test(A.html('timeline')));

console.log('\n— PERF —');
{
  // Model hot path (what runs every second), heavyweight state: 50-op queue, full log
  const head = clientSrc.split('/* ================= Ops, log, drafts')[0];
  const shim = 'const localStorage={getItem:()=>null,setItem:()=>{}};';
  const m = new Function(shim + head + `
    for (let i = 0; i < 36; i++) serverEnds[i + 1] = new Date(+RACE_PLANNED + i * 3e6).toISOString();
    for (let i = 0; i < 50; i++) queue.push({ id: 'q'+i, kind: i % 3 ? 'record' : 'kills', leg: (i % 36) + 1,
      whenISO: new Date().toISOString(), kills: 5, ts: i });
    const t0 = process.hrtime.bigint();
    const N = 20000;
    for (let i = 0; i < N; i++){ currentLeg(); const p = projections(); for (const L of LEGS){ actualEnd(L.leg); killsFor(L.leg); } }
    return Number(process.hrtime.bigint() - t0) / 1e6 / N;`)();
  console.log('  model tick (36 legs, 50-op queue): ' + (m * 1000).toFixed(1) + ' µs  (budget: 1000 µs)');
  check('model tick under 1ms', m < 1);
}
{
  // Full render() through the tick interval, 1000 frames
  const R = makeClient(W); await settle(12);
  const tick = R.timers.intervals[0].fn;
  tick(); // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) tick();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 1000;
  console.log('  full render frame (36 legs + 7 exchanges + history): ' + ms.toFixed(2) + ' ms  (budget: 16 ms; runs 1×/s)');
  check('render frame well under a 60fps frame', ms < 16);
  const bytes = Object.entries(R.store.data).reduce((a, [k, v]) => a + k.length + v.length, 0);
  console.log('  localStorage footprint after full race state: ' + (bytes / 1024).toFixed(1) + ' KB  (iOS budget: ~5000 KB)');
  check('storage footprint tiny', bytes < 200 * 1024);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
