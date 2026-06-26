/**
 * background.js — service worker.
 *
 *  - TAB PRESENCE: on Chrome startup and every 5 min, ensure one pinned,
 *    background info-kierowca.pl tab is open (reopen if you closed it). The
 *    content script then keeps that tab's session alive and watches for slots.
 *  - ALERTS: when the content script finds a new/earlier practice slot, fire a
 *    desktop notification AND an ntfy push so you can jump in and submit.
 */
const RESERVATION_URL = 'https://info-kierowca.pl/reservation';
const MATCH = 'https://info-kierowca.pl/*';
const ALARM = 'keep-tab';
const PERIOD_MIN = 5;
const NTFY_TOPIC = 'prawkomagda';
const TAG = '[session-keeper:bg]';

// 64x64 solid blue square PNG (data URI) — chrome.notifications needs an icon.
const ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAQElEQVR42u3PMQ0AAAjAMPybhnsKxg' +
  'pIqLljZ6sCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICDwLrCAAQ1q0gG0AAAAAElFTkSuQmCC';

async function ensureTab() {
  try {
    const tabs = await chrome.tabs.query({ url: MATCH });
    if (tabs.length === 0) {
      await chrome.tabs.create({ url: RESERVATION_URL, pinned: true, active: false });
      console.log(`${TAG} opened info-kierowca tab @ ${new Date().toISOString()}`);
    }
  } catch (e) { console.log(`${TAG} ensureTab error:`, e.message || e); }
}

function arm() { chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MIN }); }

chrome.runtime.onInstalled.addListener(() => { arm(); ensureTab(); });
chrome.runtime.onStartup.addListener(() => { arm(); ensureTab(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) ensureTab(); });
arm();
ensureTab();

// Slot alerts from the content script.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'slot-alert') {
    const title = msg.title || 'Egzamin — termin';
    const message = msg.message || '';
    // Desktop notification (instant, even if your phone's away).
    try {
      chrome.notifications.create('', {
        type: 'basic', iconUrl: ICON, title, message,
        priority: 2, requireInteraction: !!msg.improved,
      });
    } catch (e) { console.log(`${TAG} notif error:`, e.message || e); }
    // ntfy push (same topic as the Render watcher).
    try {
      fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
        method: 'POST',
        body: message,
        headers: {
          Title: title.normalize('NFD').replace(/[^\x20-\x7E]/g, '').trim() || 'Exam watch (Chrome)',
          Priority: msg.improved ? 'high' : 'default',
          Tags: msg.improved ? 'car' : 'calendar',
        },
      }).catch(() => {});
    } catch (e) {}
    console.log(`${TAG} slot-alert: ${title} — ${message.replace(/\n/g, ' | ')}`);
  }
});
