/**
 * watcher.js — headless-Chromium daemon (Playwright).
 *
 * Loads info-kierowca.pl while logged in (session seeded via storageState),
 * keeps the session alive by (a) injecting synthetic activity so the SPA's
 * 10-min inactivity logout never fires and (b) letting the site's own JS
 * refresh the short-lived JWT. Polls the exams API every 5 min from inside
 * the page and pushes an ntfy notification when a PRACTICE slot appears at
 * a target word centre.
 *
 * Verified behaviour: with activity injected, the SPA self-refreshes the
 * token (e.g. exp 23:23:33 -> 23:36:42) and the session sustains indefinitely.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const NTFY_BASE   = process.env.NTFY_BASE   || 'https://ntfy.sh';
const NTFY_TOPIC  = process.env.NTFY_TOPIC  || '';
const STORAGE     = process.env.STORAGE_STATE || '/etc/secrets/storageState.json';   // uploaded seed (read-only)
const DATA_DIR    = process.env.DATA_DIR || '/tmp';                                   // mount a persistent disk here
const LIVE_STATE  = path.join(DATA_DIR, 'storageState.json');                         // rotated session, survives restarts
const CHECK_MS    = (parseInt(process.env.CHECK_INTERVAL || '300', 10)) * 1000;
const RESERVATION = 'https://info-kierowca.pl/reservation';
const EXAMS_URL   = 'https://info-kierowca.pl/bknd/exam/api/v1/Schedules/user/MultipleCentersExams';

const TARGET_WORDS = JSON.parse(process.env.TARGET_WORDS ||
  '["PORD Gda\\u0144sk","PORD Gda\\u0144sk O/Gdynia"]');
const PAYLOAD = {
  startDate:      process.env.START_DATE     || '2026-06-27',
  organizationId: JSON.parse(process.env.ORG_IDS || '[43,42,53,73,9]'),
  category:       parseInt(process.env.CATEGORY || '5', 10),
  profileNumber:  process.env.PROFILE_NUMBER || '',   // set via Render env var (PII — not in repo)
  profileType:    process.env.PROFILE_TYPE   || 'Pkk',
};
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Decode the JWT exp from a storageState file (0 if missing/unreadable).
function stateExp(file) {
  try {
    const ss = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tok = (ss.cookies || []).find((c) => c.name === '__Secure-PUDOJT')?.value;
    if (!tok) return 0;
    const p = tok.split('.')[1];
    return JSON.parse(Buffer.from(p, 'base64url').toString()).exp || 0;
  } catch { return 0; }
}

// Choose the session source with the NEWEST token: a freshly-uploaded seed
// beats a stale disk copy; a live rotated disk copy beats an old seed.
function pickStorage() {
  const seed = stateExp(STORAGE), live = stateExp(LIVE_STATE);
  if (live && live >= seed) { log('using persisted session (exp', live, ')'); return LIVE_STATE; }
  log('using seed session (exp', seed, ')');
  return STORAGE;
}

async function saveState(context) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); await context.storageState({ path: LIVE_STATE }); }
  catch (e) { log('saveState ERR', e.message); }
}

// HTTP header values must be Latin1 — strip emoji/Polish from the Title
// (emoji is conveyed via the Tags header; UTF-8 body carries the real text).
const asciiHeader = (s) => String(s).replace(/[^\x20-\x7E]/g, '').trim();

async function notify(title, message, { tags = 'car', priority = 'high' } = {}) {
  if (!NTFY_TOPIC) { log('NTFY_TOPIC unset; would notify:', title, '-', message); return; }
  try {
    await fetch(`${NTFY_BASE}/${NTFY_TOPIC}`, {
      method: 'POST',
      body: Buffer.from(message, 'utf8'),          // UTF-8 body (Polish chars OK)
      headers: {
        Title: asciiHeader(title) || 'Exam watch',
        Priority: priority,
        Tags: tags,
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
    log('ntfy:', title, '-', message.replace(/\n/g, ' | '));
  } catch (e) { log('ntfy ERR', e.message); }
}

// Injected into the page on every navigation: dispatch activity every 60s so
// the SPA's inactivity timer never fires (it lets the site refresh the token).
function keepAliveScript() {
  if (window.__ka) return;
  let n = 0;
  const fire = () => {
    n++;
    const o = { bubbles: true, cancelable: true, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', { ...o, clientX: 100 + (n % 50), clientY: 200 + (n % 30) }));
    document.dispatchEvent(new MouseEvent('mousedown', o));
    document.dispatchEvent(new MouseEvent('mouseup', o));
    document.dispatchEvent(new KeyboardEvent('keydown', { ...o, key: 'Shift' }));
    document.dispatchEvent(new Event('scroll', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', o));
  };
  window.__ka = setInterval(fire, 60000);
  fire();
}

const HEARTBEAT_MS = (parseInt(process.env.HEARTBEAT_HOURS || '12', 10)) * 3600 * 1000;
let lastState = null;       // JSON of { word: earliest practice dt|null }
let lastHeartbeat = 0;
let deadAlerted = false;

const fmt = (dt) => dt ? dt.replace('T', ' ').slice(0, 16) : 'brak';   // "brak" = none

// "Gdańsk: 2026-07-24 15:00 | Gdynia: brak"
function summarize(byWord) {
  return TARGET_WORDS.map((w) => {
    const short = w.replace('PORD Gdańsk O/', '').replace('PORD ', '');
    return `${short}: ${fmt(byWord[w])}`;
  }).join('\n');
}

async function alertDead() {
  if (!deadAlerted) {
    await notify('Exam watch: session expired',
      'Re-seed storageState (seed-storagestate.py) and update the Render secret.', { tags: 'warning' });
    deadAlerted = true;
  }
}

async function checkSlots(page) {
  if (page.url().includes('/login') || page.url().includes('/logged-out')) { await alertDead(); return; }

  const res = await page.evaluate(async ({ url, payload, targets }) => {
    try {
      const r = await fetch(url, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) return { status: r.status };
      const data = await r.json();
      const byWord = {};
      for (const w of targets) byWord[w] = null;   // ensure every target present
      for (const w of data) {
        if (!targets.includes(w.wordName)) continue;
        for (const e of (w.examCollectionForDay || [])) {
          if (e.examType === 'Practice' && e.practiceDateTime) {
            if (!byWord[w.wordName] || e.practiceDateTime < byWord[w.wordName]) {
              byWord[w.wordName] = e.practiceDateTime;
            }
          }
        }
      }
      return { status: 200, byWord };
    } catch (e) { return { status: 0, err: String(e) }; }
  }, { url: EXAMS_URL, payload: PAYLOAD, targets: TARGET_WORDS });

  if (res.status === 401 || res.status === 403) { await alertDead(); return; }
  if (res.status !== 200) { log('slot check status', res.status, res.err || ''); return; }

  deadAlerted = false;
  const { byWord } = res;
  const stateKey = JSON.stringify(byWord);
  const now = Date.now();
  log('slots:', TARGET_WORDS.map((w) => `${w}=${fmt(byWord[w])}`).join(', '));

  if (stateKey !== lastState) {
    // did any city get an earlier (or first) practice slot than before?
    let improved = false;
    const prev = lastState ? JSON.parse(lastState) : {};
    for (const w of TARGET_WORDS) {
      const cur = byWord[w], old = prev[w];
      if (cur && (!old || cur < old)) improved = true;
    }
    const any = TARGET_WORDS.some((w) => byWord[w]);
    await notify(
      improved ? 'Earlier practice slot!' : 'Exam slots updated',
      summarize(byWord),
      { priority: improved ? 'high' : 'default', tags: improved ? 'car' : 'calendar' }
    );
    lastState = stateKey;
    lastHeartbeat = now;
  } else if (HEARTBEAT_MS > 0 && now - lastHeartbeat >= HEARTBEAT_MS) {
    // periodic snapshot so the app always shows a recent "current state"
    await notify('Exam slots (status)', summarize(byWord), { priority: 'min', tags: 'calendar' });
    lastHeartbeat = now;
  }
}

async function main() {
  if (!NTFY_TOPIC) log('WARNING: NTFY_TOPIC not set — notifications disabled');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const context = await browser.newContext({ storageState: pickStorage(), userAgent: UA });
  await context.addInitScript(keepAliveScript);
  const page = await context.newPage();

  log('navigating to reservation page…');
  await page.goto(RESERVATION, { waitUntil: 'networkidle', timeout: 60000 }).catch(e => log('goto warn', e.message));
  await page.waitForTimeout(3000);

  if (page.url().includes('/login') || page.url().includes('/logged-out')) {
    await notify('Exam watch: not logged in',
      'The seeded session was already invalid. Re-seed storageState and redeploy.', { tags: 'warning' });
    log('FATAL: seeded session invalid (', page.url(), ')');
  } else {
    await notify('Exam watch started',
      'Monitoring PORD Gdańsk / Gdynia for practice slots.', { tags: 'white_check_mark', priority: 'low' });
    log('logged in OK:', page.url());
  }

  // poll loop — persist the (rotated) session each cycle so restarts resume it
  for (;;) {
    await checkSlots(page).catch(e => log('check ERR', e.message));
    await saveState(context);
    await page.waitForTimeout(CHECK_MS);
  }
}

main().catch(async (e) => {
  console.error('fatal', e);
  process.exit(1);   // Render restarts the worker
});
