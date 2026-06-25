# exam-watcher

Headless-browser daemon that watches [info-kierowca.pl](https://info-kierowca.pl)
for a **practice** driving-exam slot at **PORD Gdańsk** / **PORD Gdańsk O/Gdynia**
and pushes an [ntfy.sh](https://ntfy.sh) notification when one appears.

## Why a real browser

The site's session is a short-lived (15 min) httpOnly JWT that can only be
renewed by the site's own JavaScript, and it logs out after 10 min of frontend
inactivity. A plain HTTP client can't sustain it. So this runs **headless
Chromium (Playwright)**: it loads the reservation page logged in, injects
synthetic activity every 60s (beats the inactivity logout), and lets the site
refresh its own token — which keeps the session alive indefinitely. It polls
the exams API from inside the page every 5 min.

## Config (environment variables)

| var | meaning |
|-----|---------|
| `NTFY_TOPIC` | ntfy topic to push to (required) |
| `PROFILE_NUMBER` | your PKK profile number (required; PII — set as env/secret, not in repo) |
| `STORAGE_STATE` | path to the seeded Playwright storageState (default `/etc/secrets/storageState.json`) |
| `CHECK_INTERVAL` | seconds between slot checks (default 300) |
| `START_DATE`, `ORG_IDS`, `CATEGORY`, `PROFILE_TYPE`, `TARGET_WORDS` | request params (see `watcher.js`) |

## Seeding the session

The session is seeded once from a real browser login. On macOS, log in to
info-kierowca.pl in Chrome, then run `seed-storagestate.py` to produce
`storageState.json` (extracted + decrypted from Chrome's cookie store). Upload
it to Render as a secret file and (re)deploy **promptly** — the seeded token is
valid ~15 min, after which the running browser must already be keeping it alive.

If the session ever dies (long outage, server-side cap), you get a
"session expired — re-seed" push; re-run the seeder and update the secret.

## Deploy

Render **background worker**, Docker runtime, built from the `Dockerfile`
(Playwright base image). `storageState.json` is a Render secret file;
`NTFY_TOPIC` and `PROFILE_NUMBER` are env vars.
