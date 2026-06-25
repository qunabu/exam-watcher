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

const NTFY_BASE   = process.env.NTFY_BASE   || 'https://ntfy.sh';
const NTFY_TOPIC  = process.env.NTFY_TOPIC  || '';
const STORAGE     = process.env.STORAGE_STATE || '/etc/secrets/storageState.json';
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

async function notify(title, message, { tags = 'car', priority = 'high' } = {}) {
  if (!NTFY_TOPIC) { log('NTFY_TOPIC unset; would notify:', title, '-', message); return; }
  try {
    await fetch(`${NTFY_BASE}/${NTFY_TOPIC}`, {
      method: 'POST', body: message,
      headers: { Title: title, Priority: priority, Tags: tags },
    });
    log('ntfy:', title, '-', message);
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

let lastSlot = null;     // de-dupe notifications across checks
let deadAlerted = false;

async function checkSlots(page) {
  const url = page.url();
  if (url.includes('/login') || url.includes('/logged-out')) {
    if (!deadAlerted) {
      await notify('Exam watch: session expired',
        'Re-seed storageState (seed-storagestate.py) and redeploy.', { tags: 'warning' });
      deadAlerted = true;
    }
    return;
  }
  const res = await page.evaluate(async ({ url, payload, targets }) => {
    try {
      const r = await fetch(url, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
        body: JSON.stringify(payload),
      });
      if (r.status === 401 || r.status === 403) return { status: r.status };
      if (!r.ok) return { status: r.status };
      const data = await r.json();
      let best = null;
      for (const w of data) {
        if (!targets.includes(w.wordName)) continue;
        for (const e of (w.examCollectionForDay || [])) {
          if (e.examType === 'Practice' && e.practiceDateTime) {
            if (!best || e.practiceDateTime < best.dt) best = { dt: e.practiceDateTime, word: w.wordName };
          }
        }
      }
      return { status: 200, best };
    } catch (e) { return { status: 0, err: String(e) }; }
  }, { url: EXAMS_URL, payload: PAYLOAD, targets: TARGET_WORDS });

  if (res.status === 401 || res.status === 403) {
    if (!deadAlerted) {
      await notify('Exam watch: session expired',
        'Re-seed storageState and redeploy.', { tags: 'warning' });
      deadAlerted = true;
    }
    return;
  }
  if (res.status !== 200) { log('slot check status', res.status, res.err || ''); return; }

  deadAlerted = false;
  if (res.best) {
    const key = `${res.best.word}|${res.best.dt}`;
    if (key !== lastSlot) {
      await notify('🚗 Practice exam slot available!', `${res.best.word} — ${res.best.dt}`);
      lastSlot = key;
    }
    log('slot:', res.best.word, res.best.dt);
  } else {
    log('no practice slot at target centres');
    lastSlot = null;   // reset so a future slot re-alerts
  }
}

async function main() {
  if (!NTFY_TOPIC) log('WARNING: NTFY_TOPIC not set — notifications disabled');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const context = await browser.newContext({ storageState: STORAGE, userAgent: UA });
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

  // poll loop
  for (;;) {
    await checkSlots(page).catch(e => log('check ERR', e.message));
    await page.waitForTimeout(CHECK_MS);
  }
}

main().catch(async (e) => {
  console.error('fatal', e);
  process.exit(1);   // Render restarts the worker
});
