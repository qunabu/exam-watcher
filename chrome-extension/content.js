/**
 * content.js — runs inside your logged-in info-kierowca.pl tab.
 *
 * Two jobs, both riding YOUR real (reliably-alive) Chrome session:
 *   1. KEEPALIVE: synthetic activity every 30s + auto-click "Przedłuż sesję"
 *      so the SPA never logs you out.
 *   2. SLOT WATCH: every 5 min, poll the exams API (same call the page makes)
 *      for the earliest PRACTICE slot at the target word centres. When a new or
 *      earlier slot appears, ping the background worker, which fires a desktop
 *      notification + an ntfy push so you can jump in and submit.
 *
 * Same-origin fetch from the page context => the session cookie is sent
 * automatically, exactly like the site's own requests.
 */
(() => {
  if (window.__ikSessionKeeper) return;
  window.__ikSessionKeeper = true;

  const TAG = '[session-keeper]';

  /* ---------------- 1. KEEPALIVE ---------------- */
  const norm = (s) =>
    (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase();

  const clickExtend = () => {
    const b = [...document.querySelectorAll('button,[role=button]')].find(
      (x) => norm(x.textContent).includes('przedluz sesj') && !x.disabled
    );
    if (b) {
      try { b.click(); console.log(`${TAG} clicked "Przedłuż sesję" @ ${new Date().toISOString()}`); return true; }
      catch (e) {}
    }
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
  try {
    new MutationObserver(() => clickExtend()).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  setInterval(fire, 30000);
  fire();

  /* ---------------- 2. SLOT WATCH ---------------- */
  const EXAMS_URL = 'https://info-kierowca.pl/bknd/exam/api/v1/Schedules/user/MultipleCentersExams';
  const TARGET_WORDS = ['PORD Gdańsk', 'PORD Gdańsk O/Gdynia'];
  const PAYLOAD_BASE = {
    organizationId: [43, 42, 53, 73, 9],
    category: 5,
    profileNumber: '81570730178223386122',
    profileType: 'Pkk',
  };
  const CHECK_MS = 5 * 60 * 1000;
  const SCAN_STEP_DAYS = 30;
  const MAX_SCANS = 8;

  const today = () => new Date().toISOString().slice(0, 10);
  const addDays = (ymd, d) => { const x = new Date(ymd + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
  const fmt = (dt) => (dt ? dt.replace('T', ' ').slice(0, 16) : 'brak');

  async function queryWindow(startDate) {
    try {
      const r = await fetch(EXAMS_URL, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
        body: JSON.stringify({ ...PAYLOAD_BASE, startDate }),
      });
      if (!r.ok) return { status: r.status };
      const data = await r.json();
      const byWord = {};
      for (const w of TARGET_WORDS) byWord[w] = null;
      for (const w of data) {
        if (!TARGET_WORDS.includes(w.wordName)) continue;
        for (const e of (w.examCollectionForDay || [])) {
          if (e.examType === 'Practice' && e.practiceDateTime) {
            if (!byWord[w.wordName] || e.practiceDateTime < byWord[w.wordName]) byWord[w.wordName] = e.practiceDateTime;
          }
        }
      }
      return { status: 200, byWord };
    } catch (e) { return { status: 0, err: String(e) }; }
  }

  function summarize(byWord) {
    return TARGET_WORDS.map((w) => `${w.replace('PORD Gdańsk O/', '').replace('PORD ', '')}: ${fmt(byWord[w])}`).join('\n');
  }

  async function checkSlots() {
    const byWord = {};
    for (const w of TARGET_WORDS) byWord[w] = null;
    let start = today();
    let ok = false;
    for (let i = 0; i < MAX_SCANS; i++) {
      if (TARGET_WORDS.every((w) => byWord[w])) break;
      const res = await queryWindow(start);
      if (res.status !== 200) {
        if (res.status === 401 || res.status === 403) console.log(`${TAG} slot watch: not logged in (status ${res.status})`);
        break;
      }
      ok = true;
      for (const w of TARGET_WORDS) if (!byWord[w] && res.byWord[w]) byWord[w] = res.byWord[w];
      start = addDays(start, SCAN_STEP_DAYS);
    }
    if (!ok) return;

    console.log(`${TAG} slots: ${TARGET_WORDS.map((w) => `${w}=${fmt(byWord[w])}`).join(', ')}`);
    const key = JSON.stringify(byWord);
    const { lastSlotState } = await chrome.storage.local.get('lastSlotState');
    if (key === lastSlotState) return;

    const prev = lastSlotState ? JSON.parse(lastSlotState) : {};
    let improved = false;
    for (const w of TARGET_WORDS) { const cur = byWord[w], old = prev[w]; if (cur && (!old || cur < old)) improved = true; }
    await chrome.storage.local.set({ lastSlotState: key });

    if (TARGET_WORDS.some((w) => byWord[w])) {
      chrome.runtime.sendMessage({
        type: 'slot-alert',
        improved,
        title: improved ? 'Wcześniejszy termin praktyki!' : 'Terminy egzaminu — zmiana',
        message: summarize(byWord),
      });
    }
  }

  checkSlots();
  setInterval(checkSlots, CHECK_MS);
  console.log(`${TAG} active — keepalive every 30s, slot watch every ${CHECK_MS / 60000} min on`, location.href);
})();
