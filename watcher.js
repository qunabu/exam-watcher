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
  // Look like a normal browser, not automation: many sites skip the silent
  // token refresh (or degrade the session) when they detect navigator.webdriver
  // or a backgrounded/hidden page. Strip those signals so the headless session
  // is renewed the same way a real Chrome tab is. Runs before page scripts.
  try {
    Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.hasFocus = () => true;
  } catch (e) {}
  if (window.__ka) return;
  const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase();
  // The decisive piece: auto-click "Przedłuż sesję" when the
  // "Sesja wkrótce wygaśnie" dialog appears — extends the session server-side
  // with NO re-login. (Same technique the gov-session keepalive extensions use.)
  const clickExtend = () => {
    const b = [...document.querySelectorAll('button,[role=button]')]
      .find((x) => norm(x.textContent).includes('przedluz sesj') && !x.disabled);
    if (b) { try { b.click(); console.log('[keepalive] clicked Przedluz sesje @ ' + new Date().toISOString()); return true; } catch (e) {} }
    return false;
  };
  let n = 0;
  const fire = () => {
    n++;
    const o = { bubbles: true, cancelable: true, view: window };
    document.dispatchEvent(new MouseEvent('mousemove', { ...o, clientX: 100 + (n % 50), clientY: 200 + (n % 30) }));
    document.dispatchEvent(new KeyboardEvent('keydown', { ...o, key: 'Shift' }));
    document.dispatchEvent(new Event('scroll', { bubbles: true }));
    clickExtend();
  };
  try {                              // catch the dialog the instant it's inserted
    new MutationObserver(() => clickExtend()).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  window.__ka = setInterval(fire, 30000);
  fire();
}

// Date scanning: the API only returns a limited window from startDate, so we
// scan forward in steps until each city has a first slot (or we hit MAX_SCANS).
const START_DATE     = process.env.START_DATE || new Date().toISOString().slice(0, 10); // default today
const SCAN_STEP_DAYS = parseInt(process.env.SCAN_STEP_DAYS || '30', 10);
const MAX_SCANS      = parseInt(process.env.MAX_SCANS || '8', 10);   // ~8 months ahead

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
      'Silent re-auth failed — re-seed storageState (seed-storagestate.py) and update the Render secret.',
      { tags: 'warning' });
    deadAlerted = true;
  }
}

const LOGGEDOUT = (u) => /\/login|\/logged-out/.test(u);

// Silent re-auth: if the identity-provider (login.gov.pl) session is still valid,
// clicking the portal's login control round-trips through it and lands back
// logged in — no 2FA. If it stalls on a gov-login/2FA screen, it can't, → false.
async function attemptReauth(page) {
  log('attempting silent re-auth via login.gov.pl…');
  try {
    await page.goto(RESERVATION, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
    if (!LOGGEDOUT(page.url())) return true;       // already back in
    // Click the login.gov.pl method CARD (NOT the generic "Zaloguj się" button,
    // which just reloads /login). This is what initiates the national-node SSO.
    const clicked = await page.evaluate(() => {
      const els = [...document.querySelectorAll('mat-card,[class*=card],a,button,[role=button]')];
      const m = els.find((e) => /login\.gov\.pl/i.test(e.textContent || '') && !/edo/i.test(e.textContent || ''));
      if (m) { m.scrollIntoView(); m.click(); return true; }
      return false;
    });
    if (!clicked) { log('re-auth: login.gov.pl card not found'); return false; }
    for (let i = 0; i < 8; i++) {                  // let the SSO redirect chain settle
      await page.waitForTimeout(2000);
      if (!LOGGEDOUT(page.url()) && /info-kierowca\.pl/.test(page.url())) return true;
    }
    log('re-auth: stalled at', page.url(), '(IdP session likely needs interactive 2FA)');
    return false;
  } catch (e) { log('re-auth error', e.message); return false; }
}

// Returns true if logged in (after a silent re-auth attempt if needed).
async function ensureLoggedIn(page) {
  if (!LOGGEDOUT(page.url())) return true;
  if (await attemptReauth(page)) { log('silent re-auth OK:', page.url()); deadAlerted = false; return true; }
  await alertDead();
  return false;
}

// Query a single date window. Returns earliest Practice dt per target word.
async function queryWindow(page, startDate) {
  return page.evaluate(async ({ url, payload, targets, startDate }) => {
    try {
      const r = await fetch(url, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
        body: JSON.stringify({ ...payload, startDate }),
      });
      if (!r.ok) return { status: r.status };
      const data = await r.json();
      const byWord = {};
      for (const w of targets) byWord[w] = null;
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
  }, { url: EXAMS_URL, payload: PAYLOAD, targets: TARGET_WORDS, startDate });
}

const addDays = (ymd, n) => {
  const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function checkSlots(page) {
  if (!(await ensureLoggedIn(page))) return;   // attempts silent re-auth before giving up

  // Scan forward window-by-window until every city has a first slot (or max scans).
  const byWord = {};
  for (const w of TARGET_WORDS) byWord[w] = null;
  let startDate = START_DATE;
  let queried = false;
  for (let i = 0; i < MAX_SCANS; i++) {
    if (TARGET_WORDS.every((w) => byWord[w])) break;     // all found
    const res = await queryWindow(page, startDate);
    if (res.status === 401 || res.status === 403) { await alertDead(); return; }
    if (res.status !== 200) { log('scan status', res.status, res.err || '', 'at', startDate); break; }
    queried = true;
    for (const w of TARGET_WORDS) if (!byWord[w] && res.byWord[w]) byWord[w] = res.byWord[w];
    startDate = addDays(startDate, SCAN_STEP_DAYS);
  }
  if (!queried) return;

  deadAlerted = false;
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

const RECYCLE_MS = (parseInt(process.env.RECYCLE_HOURS || '3', 10)) * 3600 * 1000;

// Cut memory/CPU: don't download images, fonts, media or 3rd-party junk.
// Keep all info-kierowca scripts/XHR/documents so the SPA boots and refreshes.
async function installResourceBlocking(context) {
  await context.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url();
    if (['image', 'media', 'font'].includes(type)) return route.abort();
    if (/google|gstatic|githubassets|msftauth|icon-icons|scorchsoft/.test(url)) return route.abort();
    return route.continue();
  });
}

// One browser lifetime: launch, run the poll loop, recycle after RECYCLE_MS.
async function runOnce() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
           '--disable-extensions', '--no-zygote', '--mute-audio',
           '--disable-blink-features=AutomationControlled',
           // Keep timers firing at full rate: headless renderers otherwise
           // throttle/pause background timers, which silently kills the every-30s
           // keepalive (and the "Przedłuż sesję" auto-click) → ~10-min logout.
           '--disable-background-timer-throttling',
           '--disable-backgrounding-occluded-windows',
           '--disable-renderer-backgrounding'],
  });
  try {
    const context = await browser.newContext({ storageState: pickStorage(), userAgent: UA });
    await installResourceBlocking(context);
    await context.addInitScript(keepAliveScript);
    const page = await context.newPage();
    page.on('console', (m) => { const t = m.text(); if (t.includes('[keepalive]')) log('PAGE', t); });

    log('navigating to reservation page…');
    await page.goto(RESERVATION, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log('goto warn', e.message));
    await page.waitForTimeout(5000);   // let Angular boot + schedule its refresh

    if (await ensureLoggedIn(page)) {
      await saveState(context);
      log('logged in OK:', page.url());
    } else {
      log('seeded session invalid and silent re-auth failed (', page.url(), ')');
    }

    const startedAt = Date.now();
    for (;;) {
      await checkSlots(page);
      await saveState(context);
      if (Date.now() - startedAt > RECYCLE_MS) { log('recycling browser to bound memory'); return; }
      await page.waitForTimeout(CHECK_MS);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

// Supervisor: keep the watcher alive forever; relaunch the browser on any crash.
async function main() {
  if (!NTFY_TOPIC) log('WARNING: NTFY_TOPIC not set — notifications disabled');
  await notify('Exam watch started',
    'Monitoring PORD Gdańsk / Gdynia for practice slots.', { tags: 'white_check_mark', priority: 'low' });
  for (;;) {
    try { await runOnce(); }
    catch (e) { log('browser crashed, relaunching in 15s:', e.message); }
    await new Promise((r) => setTimeout(r, 15000));
  }
}

main();
