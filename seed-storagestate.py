#!/usr/bin/env python3
"""
seed-storagestate.py — build a Playwright storageState.json from the
info-kierowca.pl session in your local Chrome (macOS).

Captures BOTH:
  - the portal session (info-kierowca.pl), and
  - the identity-provider session (login.gov.pl / *.gov.pl)
so the headless watcher can silently re-authenticate when the portal session
caps out — without needing a fresh interactive login each time.

Run while logged in to info-kierowca.pl in Chrome, then upload the resulting
storageState.json to Render as a secret file and (re)deploy promptly.

Requires: pip3 install cryptography
"""
import subprocess, sqlite3, hashlib, os, shutil, tempfile, json, sys
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

# Domains whose cookies we need: the portal + the national identity node.
DOMAIN_LIKE = ["%info-kierowca.pl", "%gov.pl"]
CHROME = os.path.expanduser("~/Library/Application Support/Google/Chrome/Default/Cookies")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storageState.json")

def key():
    pw = subprocess.check_output(["security", "find-generic-password", "-wa", "Chrome"], text=True).strip()
    return hashlib.pbkdf2_hmac("sha1", pw.encode(), b"saltysalt", 1003, 16)

def dec(buf, k):
    if buf[:3] not in (b"v10", b"v11"):
        return None
    c = Cipher(algorithms.AES(k), modes.CBC(b" " * 16), backend=default_backend()).decryptor()
    o = c.update(buf[3:]) + c.finalize(); o = o[:-o[-1]]
    try:
        return o.decode()                         # strict — raises if 32-byte prefix present
    except UnicodeDecodeError:
        return o[32:].decode(errors="replace")    # strip Chrome's SHA256 domain-hash prefix

def main():
    k = key()
    tmp = tempfile.mktemp(suffix=".db"); shutil.copy2(CHROME, tmp)
    con = sqlite3.connect(tmp)
    where = " OR ".join("host_key LIKE ?" for _ in DOMAIN_LIKE)
    rows = con.execute(
        f"SELECT host_key, name, encrypted_value, path, is_httponly, is_secure, expires_utc "
        f"FROM cookies WHERE {where}", DOMAIN_LIKE).fetchall()
    os.remove(tmp)

    cookies, by_host = [], {}
    for host, name, ev, path, httponly, secure, exp_utc in rows:
        val = dec(ev, k)
        if val is None:
            continue
        expires = (exp_utc / 1_000_000 - 11644473600) if exp_utc else -1
        cookies.append({
            "name": name, "value": val, "domain": host, "path": path or "/",
            "expires": expires if expires and expires > 0 else -1,
            "httpOnly": bool(httponly), "secure": bool(secure), "sameSite": "Lax",
        })
        by_host.setdefault(host, []).append(name)

    names = [c["name"] for c in cookies]
    if "__Secure-PUDOJT" not in names:
        sys.exit("No __Secure-PUDOJT cookie — are you logged in to info-kierowca.pl in Chrome?")

    json.dump({"cookies": cookies, "origins": []}, open(OUT, "w"), ensure_ascii=False, indent=1)
    print(f"Wrote {OUT} with {len(cookies)} cookies across {len(by_host)} hosts:")
    for h in sorted(by_host):
        print(f"  {h}: {len(by_host[h])} cookies")
    gov = [h for h in by_host if "gov.pl" in h]
    print("identity-provider cookies captured:", "YES" if gov else "NO (silent re-auth won't work)")

if __name__ == "__main__":
    main()
