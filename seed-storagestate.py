#!/usr/bin/env python3
"""
seed-storagestate.py — build a Playwright storageState.json from the
info-kierowca.pl session in your local Chrome (macOS).

Run this while logged in to info-kierowca.pl in Chrome, then upload the
resulting storageState.json to Render as a secret file. Do this shortly
before (re)deploying — the seeded token is only valid ~15 min, after which
the headless browser must already be running and keeping it alive.

Requires: pip3 install cryptography
"""
import subprocess, sqlite3, hashlib, os, shutil, tempfile, json, sys
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

HOST = "info-kierowca.pl"
CHROME = os.path.expanduser("~/Library/Application Support/Google/Chrome/Default/Cookies")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storageState.json")

def key():
    pw = subprocess.check_output(["security","find-generic-password","-wa","Chrome"], text=True).strip()
    return hashlib.pbkdf2_hmac("sha1", pw.encode(), b"saltysalt", 1003, 16)

def dec(buf, k):
    if buf[:3] not in (b"v10", b"v11"): return None
    c = Cipher(algorithms.AES(k), modes.CBC(b" "*16), backend=default_backend()).decryptor()
    o = c.update(buf[3:]) + c.finalize(); o = o[:-o[-1]]
    try: return o.decode()
    except UnicodeDecodeError: return o[32:].decode(errors="replace")

def main():
    k = key()
    tmp = tempfile.mktemp(suffix=".db"); shutil.copy2(CHROME, tmp)
    rows = sqlite3.connect(tmp).execute(
        "SELECT name, encrypted_value, path, is_httponly, is_secure, expires_utc "
        "FROM cookies WHERE host_key LIKE ?", (f"%{HOST}%",)).fetchall()
    os.remove(tmp)

    cookies = []
    for name, ev, path, httponly, secure, exp_utc in rows:
        val = dec(ev, k)
        if val is None: continue
        # Chrome expires_utc is microseconds since 1601; convert to unix seconds
        expires = (exp_utc/1_000_000 - 11644473600) if exp_utc else -1
        cookies.append({
            "name": name, "value": val, "domain": f".{HOST}", "path": path or "/",
            "expires": expires if expires and expires > 0 else -1,
            "httpOnly": bool(httponly), "secure": bool(secure), "sameSite": "Lax",
        })
    names = [c["name"] for c in cookies]
    if "__Secure-PUDOJT" not in names:
        sys.exit(f"No __Secure-PUDOJT cookie — are you logged in to {HOST} in Chrome?")

    json.dump({"cookies": cookies, "origins": []}, open(OUT, "w"), ensure_ascii=False, indent=1)
    print(f"Wrote {OUT} with {len(cookies)} cookies: {', '.join(names)}")
    print("Upload it to Render as the storageState.json secret file, then redeploy SOON (token ~15 min).")

if __name__ == "__main__":
    main()
