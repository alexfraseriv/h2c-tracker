/**
 * Hood to Coast 2026 — Race Tracker backend (v2)
 * -----------------------------------------------
 * Deploy from the team spreadsheet: Extensions → Apps Script → paste this file.
 * Run verifySetup() once, then smokeTest() (writes + clears a dummy time on leg 36).
 * Deploy → New deployment → Web app → Execute as: Me → Access: Anyone.
 *
 * v2 changes:
 *  - Returns LIVE predicted data (runner, miles, planned start/end) so pace or
 *    roster edits made directly in the sheet flow into the app.
 *  - Stores the ACTUAL race start (gun time) in Script Properties — the sheet
 *    layout is never modified.
 *  - One "batch" action: records + clears + race start in a single round trip
 *    (less radio time on phones).
 *  - Layout detection is cached for 10 min and state responses for 15 s
 *    (CacheService), so 12 phones polling doesn't re-scan the sheet each time.
 */

const CONFIG = {
  SPREADSHEET_ID: '',                 // leave blank when bound to the sheet
  TEAM_KEY: 'seaside-or-bust-2026',   // must match index.html
  MARKERS: {
    endEdit: 'End Time (EDIT THESE CELLS)',
    actStart: 'Start Time (DO NOT MODIFY)',
    check: 'Finish? (CHECK)',
    leg: 'Leg #',
    runnerNo: 'Runner #',
    runner: 'Runner',
    miles: 'Miles',
    predStart: 'Start Time',          // exact match → predicted block only
    predEnd: 'End Time',              // exact match → predicted block only
  },
  LEG_COUNT: 36,
  KILLS_SHEET: 'App Kills',           // created automatically; tracker tab is never touched
  STATE_CACHE_SEC: 15,
  LAYOUT_CACHE_SEC: 600,
};

/* ---------------------------------------------------------------- entry */

function doGet(e) {
  return respond_(() => {
    requireKey_(e && e.parameter && e.parameter.key);
    return { ok: true, state: getState_(false) };
  });
}

function doPost(e) {
  return respond_(() => {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    requireKey_(body.key);

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      // v2 batch payload; legacy single-action payloads still accepted.
      const records = body.records || (body.action === 'record' ? body.records : []) || [];
      const clears = body.clears || (body.action === 'clear' ? body.legs : []) || [];
      records.forEach((r) => recordLeg_(Number(r.leg), String(r.endTimeISO)));
      clears.forEach((leg) => clearLeg_(Number(leg)));
      (body.kills || []).forEach((k) => setKills_(Number(k.leg), k.kills));

      if (body.raceStart === 'CLEAR') {
        PropertiesService.getScriptProperties().deleteProperty('RACE_START_ACTUAL');
      } else if (body.raceStart) {
        const d = new Date(body.raceStart);
        if (isNaN(d.getTime())) throw new Error('Bad race start time');
        PropertiesService.getScriptProperties().setProperty('RACE_START_ACTUAL', d.toISOString());
      }

      SpreadsheetApp.flush();
    } finally {
      // Even a failed batch may have applied some writes before throwing, so
      // always drop the cached state — success or not.
      CacheService.getScriptCache().remove('state');
      lock.releaseLock();
    }
    return { ok: true, state: getState_(true) };
  });
}

/* ------------------------------------------------------------- actions */

function recordLeg_(leg, endTimeISO) {
  if (!(leg >= 1 && leg <= CONFIG.LEG_COUNT)) throw new Error('Bad leg: ' + leg);
  const when = new Date(endTimeISO);
  if (isNaN(when.getTime())) throw new Error('Bad time for leg ' + leg);
  const L = layout_();
  const row = legRow_(L, leg);
  L.sheet.getRange(row, L.cols.endEdit).setValue(when);
  if (L.cols.check) L.sheet.getRange(row, L.cols.check).setValue(true);
}

function clearLeg_(leg) {
  if (!(leg >= 1 && leg <= CONFIG.LEG_COUNT)) throw new Error('Bad leg: ' + leg);
  const L = layout_();
  const row = legRow_(L, leg);
  L.sheet.getRange(row, L.cols.endEdit).clearContent();
  if (L.cols.check) L.sheet.getRange(row, L.cols.check).setValue(false);
}

/* --------------------------------------------------------------- state */

function getState_(skipCache) {
  const cache = CacheService.getScriptCache();
  if (!skipCache) {
    const hit = cache.get('state');
    if (hit) return JSON.parse(hit);
  }

  const L = layout_();
  const c = L.cols;
  const width = Math.max(c.endEdit, c.check || 0, c.actStart || 0, c.leg, c.runnerNo || 0, c.runner, c.miles, c.predStart || 0, c.predEnd || 0);
  const values = L.sheet.getRange(L.firstRow, 1, CONFIG.LEG_COUNT, width).getValues();

  const legs = values.map((row) => {
    const get = (col) => (col ? row[col - 1] : '');
    const edited = get(c.endEdit);
    // The sheet's own convention (its delta math works the same way): a value
    // sitting in "End Time (EDIT THESE CELLS)" only counts once "Finish? (CHECK)"
    // is TRUE. The live sheet ships with stale defaults in the edit column, so
    // gating on the checkbox is what keeps the app from booting "race over".
    // recordLeg_ ticks the box; clearLeg_ unticks it.
    const finished = get(c.check) === true;
    return {
      leg: Number(get(c.leg)),
      runnerNum: Number(get(c.runnerNo)) || null,
      runner: String(get(c.runner)),
      miles: Number(get(c.miles)) || null,
      predStart: iso_(get(c.predStart)),
      predEnd: iso_(get(c.predEnd)),
      actEnd: finished ? iso_(edited) : null,
      done: finished && edited instanceof Date,
    };
  });

  const state = {
    fetchedAt: new Date().toISOString(),
    raceStartActual: PropertiesService.getScriptProperties().getProperty('RACE_START_ACTUAL') || null,
    legs: legs,
    kills: readKills_(),
  };
  cache.put('state', JSON.stringify(state), CONFIG.STATE_CACHE_SEC);
  return state;
}

/* -------------------------------------------------------- sheet layout */

function layout_() {
  const cache = CacheService.getScriptCache();
  const ss = CONFIG.SPREADSHEET_ID
    ? SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();

  const cached = cache.get('layout');
  if (cached) {
    try {
      const p = JSON.parse(cached);
      const sheet = ss.getSheetByName(p.sheetName);
      // sanity: leg column still says 1 in the first data row
      if (sheet && Number(sheet.getRange(p.firstRow, p.cols.leg).getValue()) === 1) {
        return { sheet: sheet, headerRow: p.headerRow, firstRow: p.firstRow, cols: p.cols };
      }
    } catch (err) { /* fall through to re-detect */ }
  }

  let sheet = null, headerRow = 0, endEditCol = 0;
  const tabs = ss.getSheets();
  for (const s of tabs) {
    const vals = s.getDataRange().getValues();
    for (let r = 0; r < vals.length && !endEditCol; r++) {
      for (let c = 0; c < vals[r].length; c++) {
        if (norm_(vals[r][c]) === norm_(CONFIG.MARKERS.endEdit)) {
          sheet = s; headerRow = r + 1; endEditCol = c + 1; break;
        }
      }
    }
    if (endEditCol) break;
  }
  if (!sheet) throw new Error('No tab contains "' + CONFIG.MARKERS.endEdit + '" (searched ' + tabs.length + ' tabs, ignoring line breaks and case)');

  const headers = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getValues()[0].map(norm_);
  const colOf = (label) => headers.indexOf(norm_(label)) + 1; // 0 → not found

  const cols = {
    endEdit: endEditCol,
    actStart: colOf(CONFIG.MARKERS.actStart),
    check: colOf(CONFIG.MARKERS.check),
    leg: colOf(CONFIG.MARKERS.leg),
    runnerNo: colOf(CONFIG.MARKERS.runnerNo),
    runner: colOf(CONFIG.MARKERS.runner),
    miles: colOf(CONFIG.MARKERS.miles),
    predStart: colOf(CONFIG.MARKERS.predStart),
    predEnd: colOf(CONFIG.MARKERS.predEnd),
  };
  if (!cols.leg) throw new Error('No "' + CONFIG.MARKERS.leg + '" column in header row ' + headerRow);

  const probe = sheet.getRange(headerRow + 1, cols.leg, 10, 1).getValues();
  let firstRow = 0;
  for (let i = 0; i < probe.length; i++) {
    if (Number(probe[i][0]) === 1) { firstRow = headerRow + 1 + i; break; }
  }
  if (!firstRow) throw new Error('Could not find the row where Leg # = 1');

  cache.put('layout', JSON.stringify({
    sheetName: sheet.getName(), headerRow: headerRow, firstRow: firstRow, cols: cols,
  }), CONFIG.LAYOUT_CACHE_SEC);

  return { sheet: sheet, headerRow: headerRow, firstRow: firstRow, cols: cols };
}

function legRow_(L, leg) {
  const row = L.firstRow + leg - 1;
  if (Number(L.sheet.getRange(row, L.cols.leg).getValue()) === leg) return row;
  const scan = L.sheet.getRange(L.firstRow, L.cols.leg, CONFIG.LEG_COUNT + 10, 1).getValues();
  for (let i = 0; i < scan.length; i++) {
    if (Number(scan[i][0]) === leg) return L.firstRow + i;
  }
  throw new Error('Leg ' + leg + ' not found');
}

/* --------------------------------------------------------------- kills */

function ss_() {
  return CONFIG.SPREADSHEET_ID
    ? SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

function killsSheet_(create) {
  const ss = ss_();
  let sh = ss.getSheetByName(CONFIG.KILLS_SHEET);
  if (!sh && create) {
    sh = ss.insertSheet(CONFIG.KILLS_SHEET);
    sh.getRange(1, 1, 1, 3).setValues([['Leg', 'Roadkills', 'Updated']]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function setKills_(leg, kills) {
  if (!(leg >= 1 && leg <= CONFIG.LEG_COUNT)) throw new Error('Bad leg for kills: ' + leg);
  const k = Math.max(0, Math.min(500, Math.round(Number(kills))));
  if (isNaN(k)) throw new Error('Bad kill count for leg ' + leg);
  killsSheet_(true).getRange(leg + 1, 1, 1, 3).setValues([[leg, k, new Date()]]); // row = leg + header
}

function readKills_() {
  const sh = killsSheet_(false);
  if (!sh) return {};
  const vals = sh.getRange(2, 1, CONFIG.LEG_COUNT, 2).getValues();
  const map = {};
  vals.forEach((r) => { if (r[0]) map[r[0]] = Number(r[1]) || 0; });
  return map;
}

/* ------------------------------------------------------------- helpers */

function requireKey_(key) {
  if (key !== CONFIG.TEAM_KEY) throw new Error('Bad or missing team key');
}

function iso_(v) {
  return v instanceof Date ? v.toISOString() : null;
}

/** Sheet headers wrap words with line breaks ("End\nTime\n(EDIT THESE CELLS)").
 *  Collapse all whitespace (incl. non-breaking spaces) and compare case-blind. */
function norm_(v) {
  return String(v).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function respond_(fn) {
  let payload;
  try {
    payload = fn();
  } catch (err) {
    payload = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/* --------------------------------------------------------------- tests */

/** Run once after pasting: confirms tab/column detection, prints legs 1–3. */
function verifySetup() {
  const sheetTz = ss_().getSpreadsheetTimeZone();
  const scriptTz = Session.getScriptTimeZone();
  if (sheetTz !== 'America/Los_Angeles' || scriptTz !== 'America/Los_Angeles') {
    Logger.log('⚠ TIME ZONE PROBLEM — sheet: "%s", script: "%s". Both must be America/Los_Angeles ' +
      'or every time will be hours off. Fix: sheet → File → Settings → Time zone → Pacific; ' +
      'script → gear icon (Project Settings) → Time zone. Then re-run verifySetup and confirm ' +
      'leg 1 predStart reads 2026-08-28T19:45:00.000Z.', sheetTz, scriptTz);
  } else {
    Logger.log('Time zones OK — sheet + script both America/Los_Angeles');
  }
  CacheService.getScriptCache().remove('layout');
  const L = layout_();
  Logger.log('Tab: %s | header row: %s | first data row: %s', L.sheet.getName(), L.headerRow, L.firstRow);
  Logger.log('Columns: %s', JSON.stringify(L.cols));
  Logger.log('Legs 1-3: %s', JSON.stringify(getState_(true).legs.slice(0, 3)));
}

/** Full write→read→clear cycle against leg 36. Safe to run before race day. */
function smokeTest() {
  const testTime = '2026-08-29T23:19:00.000Z';
  recordLeg_(36, testTime);
  SpreadsheetApp.flush();
  const after = getState_(true).legs[35];
  const wrote = after.actEnd && Math.abs(new Date(after.actEnd) - new Date(testTime)) < 1500;
  clearLeg_(36);
  SpreadsheetApp.flush();
  CacheService.getScriptCache().remove('state');
  const cleared = getState_(true).legs[35].actEnd === null;
  setKills_(36, 7);
  const killsOk = readKills_()[36] === 7;
  setKills_(36, 0);
  Logger.log(wrote && cleared && killsOk
    ? 'PASS — wrote %s to leg 36, read it back, cleared it; kills tab round-trip ok.'
    : 'FAIL — wrote:%s cleared:%s kills:%s → check columns with verifySetup()', after.actEnd, cleared, killsOk);
}
