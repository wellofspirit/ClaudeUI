"""Does the session PATCH payload schema reject unknown fields?

Creates a session, then PATCHes it with an unknown key, on whichever binary is
given. Run against BOTH the unpatched release build and the patched fork build.

Usage: python probe-patch-schema.py <binary>
"""

import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

binary = sys.argv[1]
password = "probe-pw"
auth = "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode()
cwd = tempfile.mkdtemp(prefix="oc-schema-")

env = dict(os.environ)
env["OPENCODE_SERVER_PASSWORD"] = password

proc = subprocess.Popen(
    [binary, "serve", "--port", "0", "--hostname", "127.0.0.1"],
    cwd=cwd,
    env=env,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
)
port = None


def rd():
    global port
    for line in proc.stdout:
        m = re.search(r"listening on http://127\.0\.0\.1:(\d+)", line)
        if m and port is None:
            port = int(m.group(1))


threading.Thread(target=rd, daemon=True).start()
deadline = time.time() + 40
while port is None and time.time() < deadline and proc.poll() is None:
    time.sleep(0.2)
if port is None:
    print("FAIL: no port")
    proc.kill()
    sys.exit(1)


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method)
    req.add_header("Authorization", auth)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


try:
    status, body = call("POST", "/session", {"title": "schema-probe"})
    print(f"POST /session -> {status}")
    sid = json.loads(body)["id"]

    st, b = call("PATCH", f"/session/{sid}", {"title": "renamed"})
    print(f"  PATCH known field only          -> {st}")

    st, b = call("PATCH", f"/session/{sid}", {"permissionHermetic": True})
    print(f"  PATCH unknown 'permissionHermetic' -> {st}: {b[:220]}")
    strict = st >= 400

    st, b = call("PATCH", f"/session/{sid}", {"title": "x", "totallyBogusField": 123})
    print(f"  PATCH unknown 'totallyBogusField'  -> {st}: {b[:220]}")

    st, b = call(
        "PATCH",
        f"/session/{sid}",
        {"permission": [{"permission": "*", "pattern": "*", "action": "deny"}], "permissionHermetic": True},
    )
    print(f"  PATCH permission + hermetic        -> {st}: {b[:220]}")

    print(f"\nSTRICT_UNKNOWN_FIELDS = {strict}")
finally:
    proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
