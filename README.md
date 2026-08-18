# H2C 2026 Van Tracker — v2

One-tap leg tracking that writes to the team Google Sheet, built for spotty coverage between Timberline and Seaside. Times are stamped **the moment the button is pressed**, held on the phone until confirmed, then queued and synced whenever a connection exists.

```
Phone (index.html, PWA)            Google Apps Script             Team Sheet
┌────────────────────────┐  POST   ┌─────────────────────┐  set  ┌──────────────┐
│ press → stamp → CONFIRM│ ──────▶ │ doPost: LockService  │ ───▶ │ End Time     │
│ queue in localStorage  │  batch  │ writes W + checkbox  │      │ (EDIT) + ✓   │
│ history: ✓ ↻ ✗ ⚠      │ ◀────── │ returns FULL state   │      │              │
└────────────────────────┘  JSON   │ (incl. planned data) │      └──────────────┘
                                   └─────────────────────┘
```

## What v2 does

- **Physical start/finish buttons with confirmation.** A green plunger records the actual gun time (stored in Script Properties — the sheet layout is never touched); the amber plunger records leg finishes. Both stamp the time on press, then show a Confirm card with ±15s/±1m nudges. Nothing is committed until Confirm. An unconfirmed stamp survives closing the app.
- **The sheet is the source of truth.** Every sync also pulls runner names, miles, and planned times from the sheet, so pace edits, runner swaps, or re-shuffled legs made directly in the sheet flow into every phone within a minute. The baked-in schedule is only a fallback for a phone that has never connected.
- **You always know what got logged.** The sync indicator in the top bar is just a dot while everything is fine; it grows a word (`Offline · 2`, `1`, `Retry`) the moment something needs you. Tap it — or History — to drop a panel under the bar with the status, the last sheet read, "Sync now", and a per-change log: `↻ queued` → `✓ Confirmed in sheet 3:48:51 AM`, or `✗ failed: <actual error> — will keep retrying`, or `⚠ conflict — sheet shows a different time, kept the sheet value`. Sync retries with backoff automatically; "Sync now" forces it.
- **Race start can shift.** Press the green button at the actual gun; every projection re-anchors. Adjustable later via "Adjust start" on the bib card.
- **Exchanges & finish.** All six van exchanges plus Seaside, each with a live ETA (based on actuals so far), a ✓ once passed, and an Open-in-Maps link from the sheet.
- **First names everywhere.** The two Brians become "Brian S" and "Brian W" automatically (recomputed from the sheet, so it still works after a roster swap).
- **Leg details, gated in order.** Tapping a leg opens its detail card (distance, plan pace, plan window, live ETA). Completed legs can be adjusted or cleared any time; the current leg can be recorded; future legs are read-only until the previous leg is in — so nobody records leg 17 by accident.
- **Roadkills 🏃🦞.** Every completed leg gets its own roadkill cell on the right of the row — the count, or a `+` if nobody's entered one yet. Tapping it opens a big −/+ stepper with quick-set chips (no scroll wheel to fight in a moving van); the saved count is always pre-filled. Counts go to a separate **App Kills** tab (auto-created; the tracker tab is never touched), sync offline like everything else, and total up in the timeline header.
- **One vocabulary.** "planned finish" = the schedule from the sheet, "ETA" = the live estimate re-figured from the times actually recorded so far. Both are spelled out under the timeline and in every leg's detail card. Weekday shows only when a time isn't on race-start day.
- **Every leg reads the same way.** `start → finish` with the duration on the right, whether or not it's been run. Legs still ahead show the estimate (dimmer, marked `est`); legs already run show the actuals. A finished leg also carries one delta — and that number is the *whole race* against the planned finish, not that runner in isolation. It's one relay chain: the offset banked at a handoff is the offset everyone downstream inherits.
- **One panel for status and settings.** The sync dot and the gear open the same sheet: sync state, "Sync now", last sheet read, Theme, Keep awake, and the change log.
- **Race-level numbers live in the bar, runner-level numbers live in the card.** The top bar carries the race clock and 🏁 the projected Seaside arrival; tap that chip to swap it for the whole race's vs-planned and tap again to put it back — it's a number worth checking, not one worth staring at all race. The bib card carries only what's true of the person currently running — time on leg, the leg's planned duration, and their ETA.
- **A top bar that keeps up.** The sticky bar carries the wordmark, race clock, and sync dot in one 52px row. Once the bib card scrolls out of view it grows a second line with whoever is running right now — leg, name, time on leg, ETA — so "who's out there?" never costs a scroll back to the top.
- **Light and dark.** Follows the phone by default; the footer's Theme button forces light or dark and remembers the choice. Both themes are real designs, not an inverted filter — the plunger stays high-vis yellow in both because it's the one control you press without looking.
- **Battery.** The app is fully suspended by iOS/Android when the phone is locked or backgrounded — zero background drain by construction. While open, it reads the sheet once a minute (a ~2 KB request) and resyncs on wake. The only real battery cost is the screen; "Keep awake" is opt-in for the navigator's phone. Backend side, layout detection and reads are cached (CacheService) so 12 phones polling stays fast and well inside Apps Script quotas.

## Setup (~10 minutes)

1. **Backend:** team sheet → Extensions → Apps Script → paste `Code.gs`. Change `TEAM_KEY`. Run `verifySetup()` (authorize; check the log shows the right tab/columns). Then run `smokeTest()` — it writes a dummy time to leg 36, reads it back, and clears it; the log should say PASS.
2. **Deploy:** Deploy → New deployment → Web app → Execute as **Me**, access **Anyone**. Copy the `/exec` URL.
3. **Client:** set `SCRIPT_URL` and `TEAM_KEY` at the top of `index.html`.
4. **Host** `index.html`, `sw.js`, `manifest.json` on GitHub Pages (or any HTTPS static host — HTTPS is required for offline reloads and keep-awake).
5. **Team:** share the link **Thursday while everyone has signal** — first load caches the app. Add to Home Screen. Note for iPhone: don't use Private Browsing (it wipes the local queue), and anyone who installed it weeks early should open it once during race week so iOS doesn't evict the cache.

## Test plan

**Stage 0a (no deploy needed): `node test/gauntlet.mjs`** — the adversarial suite: boots the full client headless against the sheet replica with a chaos network. Covers dead-zone batching, dropped responses after server apply, captive portals + backoff caps, mid-flight edits, dueling phones (LWW convergence), poisoned queues, private browsing, login-page deploys, 30s hung-request timeouts, hostile sheet edits (XSS names, inserted rows, renamed headers), clock skew, malformed state, and perf (model tick ~57µs, full render ~0.7ms, storage ~5KB).

**Stage 0b (no deploy needed): `node test/local-e2e.mjs`** — runs the real Code.gs against a replica of the live sheet (structure captured 8/17). Verifies layout detection, checkbox gating, writes/clears/kills, cache invalidation, and that the baked schedule in index.html still matches the sheet. All 26 checks green as shipped.

**Note on the Finish? checkbox:** the live sheet already has stale values sitting in "End Time (EDIT THESE CELLS)". A leg only counts as finished when "Finish? (CHECK)" is TRUE — same rule the sheet's own delta math uses. The app ticks/unticks the box automatically; anyone hand-typing a time directly in the sheet must also tick the box. (no teammates required)

1. **Backend unit:** `verifySetup()` then `smokeTest()` in the Apps Script editor.
2. **Full pipeline sim:** from a laptop, `node test/simulate.mjs "<exec-url>" "<team-key>" --yes`. It plays three phones with flaky connections: race start, all 36 legs in random offline batches, duplicate resends, a correction, a conflicting write, a clear — then verifies every value via GET and wipes everything. It refuses to run if the sheet already has real times. Expect `🎉 N passed, 0 failed`.
3. **Phone drill (5 min, your iPhone):** open the hosted app → press start → confirm → airplane mode → record two legs → pill shows `Offline · 2 queued`, history shows `✗ No connection — will keep retrying` → force-quit and reopen (queue survives) → airplane off → watch both flip to `✓ Confirmed in sheet` and the times appear in the actual sheet → tap each leg → Clear to reset.

## Notes

- Auth = the URL + team key. Anyone with both can write; the sheet itself is never exposed and the script runs under your account. Fine for 12 friends.
- Conflict model is last-write-wins per leg, and the sheet's value always wins on disagreement — the history log tells the loser what happened.
- If headers get renamed in the sheet, re-run `verifySetup()`; detection is by header text.
