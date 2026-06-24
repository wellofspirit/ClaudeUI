#!/usr/bin/env python3
"""Probe: drive an opencode `task` (subagent) call and dump the raw /event stream.

Confirms the child-session event-filter hypothesis: opencode runs the task
subagent in a CHILD session with its own sessionID, and ClaudeUI's event-mapper
drops every event whose sessionID != the parent. We log EVERY event with its
type + sessionID so we can see exactly which child event (permission.asked /
session.error / message.part.*) the parent turn blocks on.

Uses the free `opencode/mimo-v2.5-free` model (no auth). Stdlib only.
"""
import base64
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request

BIN = os.path.join("vendor", "opencode-cli", "opencode.exe")
PASSWORD = "probe-pw"
AUTH = "Basic " + base64.b64encode(("opencode:" + PASSWORD).encode()).decode()
MODEL = {"providerID": "opencode", "modelID": "mimo-v2.5-free"}
PROMPT = "Hi, research how chatview works."
RUN_SECONDS = 90
REPLY = os.environ.get("REPLY", "1") == "1"
T0 = time.time()

root_session = None
child_sessions = set()
BASE = None  # set in main, used by handle_event to auto-reply


def req(method, base, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        base + path, data=data, method=method,
        headers={"Authorization": AUTH, "Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(r, timeout=30) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def sse_thread(base, stop):
    r = urllib.request.Request(base + "/event", headers={"Authorization": AUTH, "Accept": "text/event-stream"})
    resp = urllib.request.urlopen(r, timeout=RUN_SECONDS + 30)
    buf = ""
    while not stop.is_set():
        chunk = resp.read(1)  # crude but fine for a probe
        if not chunk:
            break
        buf += chunk.decode("utf-8", "replace")
        if buf.endswith("\n\n"):
            for line in buf.splitlines():
                line = line.strip()
                if line.startswith("data:"):
                    try:
                        ev = json.loads(line[5:].strip())
                    except Exception:
                        continue
                    handle_event(ev)
            buf = ""


def handle_event(ev):
    global root_session
    t = ev.get("type", "?")
    props = ev.get("properties", {}) or {}
    sid = props.get("sessionID")
    # discover child sessions
    if t == "session.created" or t == "session.updated":
        info = props.get("info", props)
        pid = info.get("parentID")
        iid = info.get("id")
        if pid and root_session and pid == root_session:
            child_sessions.add(iid)
            print(f"  >>> CHILD SESSION created: {iid} (parent={pid})")
    tag = "ROOT " if sid == root_session else ("CHILD" if sid in child_sessions else (" --- " if sid is None else "OTHER"))
    # only print the interesting events to keep output readable
    interesting = t in (
        "permission.asked", "permission.replied", "session.error", "session.idle",
        "session.created", "session.updated",
        "session.next.step.started", "session.next.step.ended", "session.next.step.failed",
        "session.next.tool.called", "session.next.tool.success", "session.next.tool.failed",
    )
    el = f"{time.time()-T0:6.1f}s"
    if t == "message.part.updated":
        part = props.get("part", {})
        if part.get("type") == "tool":
            print(f"{el} [{tag}] {t:28} sid={sid[-6:]} TOOL={part.get('tool')} status={(part.get('state') or {}).get('status')}")
        return
    if interesting:
        extra = ""
        if t == "permission.asked":
            extra = " FULL=" + json.dumps(props)[:400]
        if t == "session.error":
            extra = f" error={json.dumps(props.get('error'))[:300]}"
        print(f"{el} [{tag}] {t:28} sid={sid[-6:] if sid else None}{extra}")
        if t == "session.idle" and sid == root_session:
            print("  *** ROOT session.idle — turn complete ***")
        if t == "permission.asked":
            pid = props.get("id")
            if REPLY and sid == root_session and pid:
                try:
                    req("POST", BASE, f"/permission/{pid}/reply", {"reply": "once"})
                    print(f"  -> auto-approved ROOT permission {pid}")
                except Exception as e:
                    print(f"  -> reply failed: {e}")
            elif pid:
                print(f"  !!! permission {pid} on sid={sid[-6:]} — REPLY={REPLY}; NOT replying")


def main():
    global root_session, BASE
    if not os.path.exists(BIN):
        print(f"binary not found: {BIN}", file=sys.stderr)
        sys.exit(1)
    env = dict(os.environ, OPENCODE_SERVER_PASSWORD=PASSWORD)
    proc = subprocess.Popen(
        [BIN, "serve", "--port", "0", "--hostname", "127.0.0.1"],
        cwd=os.getcwd(), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    base = None
    pat = re.compile(r"listening on (http://127\.0\.0\.1:\d+)")
    t0 = time.time()
    while time.time() - t0 < 20:
        line = proc.stdout.readline()
        if not line:
            break
        m = pat.search(line)
        if m:
            base = m.group(1)
            break
    if not base:
        print("server did not start", file=sys.stderr)
        proc.kill()
        sys.exit(1)
    print(f"server: {base}")
    BASE = base

    stop = threading.Event()
    th = threading.Thread(target=sse_thread, args=(base, stop), daemon=True)
    th.start()
    time.sleep(1)

    s = req("POST", base, "/session", {"title": "probe"})
    root_session = s["id"]
    print(f"root session: {root_session}")

    # Mimic the app's DEFAULT ("ask") permission mode: OpencodeSession.applyPermissionMode
    # patches the parent session to ask-all. Question: does the CHILD subagent
    # session inherit this, and where does permission.asked's sessionID point?
    req("PATCH", base, f"/session/{root_session}", {"permission": [{"permission": "*", "pattern": "*", "action": "ask"}]})
    print("patched root session → ask-all (mimics app default mode)")

    req("POST", base, f"/session/{root_session}/prompt_async", {"model": MODEL, "parts": [{"type": "text", "text": PROMPT}]})
    print("prompt sent; watching events...\n")

    time.sleep(RUN_SECONDS)
    stop.set()
    print("\n=== SUMMARY ===")
    print(f"root session: {root_session}")
    print(f"child sessions discovered: {child_sessions or 'NONE'}")
    proc.kill()


if __name__ == "__main__":
    main()
