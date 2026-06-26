# info-kierowca session keeper (Chrome extension)

Keeps you logged in to **info-kierowca.pl** in your own Chrome — for as long as
the machine (and Chrome) is on:

- **`background.js`** — on Chrome startup and **every 5 minutes**, ensures one
  **pinned, background** info-kierowca.pl tab is open (reopens it if you closed
  it). The site allows only one tab, so it opens one only when none exists.
- **`content.js`** — inside that tab, dispatches synthetic activity every 30s
  (beats the ~10-min inactivity logout) and auto-clicks **"Przedłuż sesję"** the
  instant the "Sesja wkrótce wygaśnie" dialog appears.

This keeps an **already-logged-in** session alive. It can't log you in from
scratch — that needs login.gov.pl / 2FA.

## Install (unpacked) — one time

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** → select this `chrome-extension/` folder
4. It immediately opens a pinned info-kierowca tab and starts keeping it alive

Unpacked extensions persist across Chrome restarts/reboots as long as this
folder stays at its current path.

## Make it survive reboots ("once the machine is on")

The extension runs whenever Chrome is running. To have Chrome (and therefore the
keeper) start automatically when you log in to the Mac, add Chrome to Login
Items:

> System Settings → General → Login Items → **+** → Google Chrome

(Or just keep Chrome open.)

## Verify it's working

- `chrome://extensions` → "info-kierowca session keeper" → **service worker**
  (Inspect) console shows `[session-keeper:bg] tab present … ok`.
- On the info-kierowca tab, DevTools console shows
  `[session-keeper] active …` and `clicked "Przedłuż sesję"` when it extends.

## Notes

- Independent of the Render watcher — both can run at once; separate cookie jars.
- The pinned tab sits in the background; pinning makes it hard to close by
  accident. If you do close it, it reopens within 5 minutes.
