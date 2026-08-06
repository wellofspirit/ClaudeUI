"""Live-fire the patched /judge/completion route (ADR-037 P1) with REAL models.

This is the bump-verification harness for the judge patch: apply-success is not
correctness, and the two failures we have actually hit — a Codex backend that
rejects non-streaming requests, and one that rejects `max_output_tokens` — are
invisible to every test that stops at the provider boundary. Run it after every
opencode version bump, against at least one API-key provider AND one
ChatGPT/Codex-OAuth model, because they exercise different transports.

Spends a handful of tokens per model. Requires the providers to be authenticated
in the opencode config this binary reads.

Usage:
  python patch/opencode-fork/live-judge.py vendor/opencode-cli/opencode.exe
  python patch/opencode-fork/live-judge.py <binary> openai/gpt-5.6-luna alicloud/qwen3.8-max-preview

Expected: every model returns 200 {"text":"VERIFIED"}.
"""

import base64
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

# Absolute, because the server is started with cwd=<repo root> below and a
# relative binary path would then resolve against the wrong directory.
binary = os.path.abspath(sys.argv[1])
models = sys.argv[2:] or ["openai/gpt-5.6-luna", "alicloud/qwen3.8-max-preview"]

password = "x"
auth = "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode()
# Serve from the repo root so the server resolves the same project/auth context
# ClaudeUI gives it. This file lives at <root>/patch/opencode-fork/.
cwd = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

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


def read_stdout():
    global port
    for line in proc.stdout:
        m = re.search(r"listening on http://127\.0\.0\.1:(\d+)", line)
        if m and port is None:
            port = int(m.group(1))


threading.Thread(target=read_stdout, daemon=True).start()
deadline = time.time() + 40
while port is None and time.time() < deadline and proc.poll() is None:
    time.sleep(0.2)
if port is None:
    print("FAIL: no port")
    proc.kill()
    sys.exit(1)

print(f"server on {port} (binary: {binary})")

failures = 0
try:
    for spec in models:
        providerID, modelID = spec.split("/", 1)
        body = {
            "model": {"providerID": providerID, "modelID": modelID},
            "system": "You are a test harness. Reply with exactly one word and nothing else.",
            "user": "Reply with the single word VERIFIED.",
            "maxTokens": 2048,
            "stopSequences": ["</block>"],
        }
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/judge/completion",
            data=json.dumps(body).encode(),
            method="POST",
        )
        req.add_header("Authorization", auth)
        req.add_header("Content-Type", "application/json")
        started = time.time()
        try:
            with urllib.request.urlopen(req, timeout=300) as res:
                out = res.read().decode("utf-8", "replace")
                print(f"  {spec} -> {res.status} in {time.time()-started:.1f}s: {out[:400]}")
        except urllib.error.HTTPError as e:
            print(
                f"  {spec} -> {e.code} in {time.time()-started:.1f}s: "
                f"{e.read().decode('utf-8','replace')[:500]}"
            )
            failures += 1
        except Exception as e:  # noqa: BLE001
            print(f"  {spec} -> EXC: {e}")
            failures += 1
finally:
    proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()

print("FAILURES", failures)
sys.exit(1 if failures else 0)
