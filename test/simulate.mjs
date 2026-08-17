#!/usr/bin/env node
/**
 * H2C tracker — end-to-end simulation against the REAL deployed backend.
 * Simulates 3 phones recording all 36 legs with offline batching, duplicate
 * sends, a correction, and a conflict — then verifies the sheet and cleans up.
 *
 * Usage:
 *   node test/simulate.mjs "https://script.google.com/macros/s/…/exec" "team-key" --yes
 *
 * ⚠ Writes to and then CLEARS the tracker tab. Run BEFORE real race data exists.
 */

const [,, URL, KEY, flag] = process.argv;
if (!URL || !KEY || flag !== '--yes') {
  console.log('Usage: node test/simulate.mjs <script-exec-url> <team-key> --yes');
  console.log('       (--yes acknowledges this writes to and clears the sheet)');
  process.exit(1);
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

async function post(body) {
  const res = await fetch(URL, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ key: KEY, ...body }),
  });
  return res.json();
}
async function get() {
  const res = await fetch(`${URL}?key=${encodeURIComponent(KEY)}`, { redirect: 'follow' });
  return res.json();
}
const near = (a, b, ms = 2000) => a && b && Math.abs(new Date(a) - new Date(b)) < ms;

(async () => {
  console.log('\n— Phase 0: connectivity & auth —');
  const base = await get();
  check('GET state', base.ok === true, base.error || `${base.state?.legs?.length} legs`);
  const badRes = await fetch(URL, { method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ key: 'wrong-key', records: [] }) }).then(r => r.json());
  check('Bad key rejected', badRes.ok === false && /key/i.test(badRes.error || ''));

  const preDirty = base.state.legs.filter(l => l.actEnd).length;
  if (preDirty) {
    console.log(`⚠ Sheet already has ${preDirty} actual times — aborting so real data isn't touched.`);
    process.exit(1);
  }

  console.log('\n— Phase 1: race start —');
  const gun = '2026-08-28T19:47:10.000Z'; // 12:47:10 PM PDT — a late gun
  let r = await post({ raceStart: gun });
  check('Race start stored', r.ok && near(r.state.raceStartActual, gun));

  console.log('\n— Phase 2: 3 phones, 36 legs, flaky connections —');
  // Fabricate plausible finish times: planned end ± up to 3 min.
  const plan = base.state.legs.map(l => l.predEnd);
  const times = plan.map(p => new Date(+new Date(p) + (Math.random() * 360000 - 180000)).toISOString());

  // Phones accumulate offline batches of 1–4 legs, then flush — like real dead zones.
  let leg = 1;
  const phones = [[], [], []];
  while (leg <= 36) {
    const phone = phones[Math.floor(Math.random() * 3)];
    phone.push({ leg, endTimeISO: times[leg - 1] });
    leg++;
    if (phone.length >= 1 + Math.floor(Math.random() * 4) || leg > 36) {
      const resp = await post({ records: phone.splice(0) });
      if (!resp.ok) check(`Batch write @ leg ${leg - 1}`, false, resp.error);
    }
  }
  // Duplicate resend (a phone retrying after a timeout it actually won)
  await post({ records: [{ leg: 5, endTimeISO: times[4] }, { leg: 6, endTimeISO: times[5] }] });

  let s = (await get()).state;
  check('All 36 legs written', s.legs.every(l => l.actEnd), `${s.legs.filter(l => l.actEnd).length}/36`);
  check('Times match (idempotent resend ok)', s.legs.every((l, i) => near(l.actEnd, times[i])));
  check('Checkboxes set', s.legs.every(l => l.done === true));

  console.log('\n— Phase 3: correction & conflict —');
  const fix12 = new Date(+new Date(times[11]) + 123000).toISOString(); // van 2 fixes leg 12 by +2:03
  r = await post({ records: [{ leg: 12, endTimeISO: fix12 }] });
  check('Correction overwrites', r.ok && near(r.state.legs[11].actEnd, fix12));
  const late = new Date(+new Date(fix12) + 60000).toISOString();       // second phone writes stale value
  r = await post({ records: [{ leg: 12, endTimeISO: late }] });
  check('Last write wins (conflict model)', r.ok && near(r.state.legs[11].actEnd, late));

  console.log('\n— Phase 4: clear one leg —');
  r = await post({ clears: [36] });
  check('Leg 36 cleared', r.ok && r.state.legs[35].actEnd === null && r.state.legs[35].done === false);

  console.log('\n— Phase 4b: roadkills → App Kills tab —');
  r = await post({ kills: [{ leg: 3, kills: 7 }, { leg: 19, kills: 12 }] });
  check('Kills stored', r.ok && r.state.kills && Number(r.state.kills[3]) === 7 && Number(r.state.kills[19]) === 12);
  r = await post({ kills: [{ leg: 3, kills: 9 }] });
  check('Kills overwrite (correction)', r.ok && Number(r.state.kills[3]) === 9);

  console.log('\n— Phase 5: predicted data comes back too —');
  check('Runner names present', s.legs.every(l => l.runner && l.runner.length > 1));
  check('Planned times present', s.legs.every(l => l.predStart && l.predEnd));

  console.log('\n— Cleanup: clearing everything —');
  r = await post({ clears: Array.from({ length: 36 }, (_, i) => i + 1), raceStart: 'CLEAR',
                   kills: [{ leg: 3, kills: 0 }, { leg: 19, kills: 0 }] });
  s = (await get()).state;
  check('All legs cleared', s.legs.every(l => l.actEnd === null));
  check('Race start cleared', s.raceStartActual === null);
  console.log('  (the "App Kills" tab itself stays in the sheet — harmless, delete it by hand if you like)');

  console.log(`\n${fail ? '❌' : '🎉'} ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('💥 Simulation crashed:', err.message); process.exit(1); });
