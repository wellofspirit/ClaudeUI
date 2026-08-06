"""Live-fire the judge route's PROMPT CACHING (ADR-037 P3) with REAL models.

`live-judge.py` proves the route answers. This proves it answers *cheaply*: the
judge's system prompt is ~24 KB of policy that never changes within a session,
so from the second call on it should be served from the provider's prompt cache
— an explicit `cache_control` breakpoint where the provider takes one, automatic
prefix caching where it does not.

The evidence is `usage.cacheReadInputTokens` in the response, which the route
reports where the provider does. Latency is recorded too, but only as a
secondary signal: it is noisy, and a provider that caches without saying so
looks the same as one that does not cache at all.

The system prompt is ClaudeUI's real one, rendered through `buildPolicyPrompt`
(needs `bun` on PATH) — using a synthetic filler would not exercise the property
that actually matters, which is that OUR document is byte-stable. The script
asserts that stability before it spends a single token.

Run this after every opencode bump alongside `live-judge.py`, and after any
change to the policy document's assembly.

`--vary-system` is the negative control: it appends a per-call marker to the
system prompt, which must drive cacheReadInputTokens back to zero. Run it once
whenever the numbers look too good — a provider reporting a cache read for a
prefix it cannot have seen would mean the metric is not measuring what we think.

Usage:
  python patch/opencode-fork/live-judge-cache.py vendor/opencode-cli/opencode.exe
  python patch/opencode-fork/live-judge-cache.py <binary> openai/gpt-5.6-luna
  python patch/opencode-fork/live-judge-cache.py <binary> --calls 5 <model ...>
  python patch/opencode-fork/live-judge-cache.py <binary> --vary-system

Expected: call 1 warms, calls 2..N report a non-zero cacheReadInputTokens on any
provider that reports cache usage at all — and zero throughout under
`--vary-system`.
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

args = sys.argv[1:]
calls = 5
vary = "--vary-system" in args
if vary:
    args.remove("--vary-system")
if "--calls" in args:
    i = args.index("--calls")
    calls = int(args[i + 1])
    del args[i : i + 2]

binary = os.path.abspath(args[0])
models = args[1:] or ["openai/gpt-5.6-luna", "alicloud/qwen3.8-max-preview"]

# This file lives at <root>/patch/opencode-fork/.
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ── The system prompt: ClaudeUI's real policy document ────────────────────────
# Rendered twice and compared. A prompt that is not byte-identical between calls
# cannot be cached by anything, and the failure mode is silent — full price, no
# error — so it is checked here rather than assumed.
render = os.path.join(tempfile.gettempdir(), "judge-cache-render.ts")
out_a = os.path.join(tempfile.gettempdir(), "judge-cache-a.txt")
out_b = os.path.join(tempfile.gettempdir(), "judge-cache-b.txt")
with open(render, "w", encoding="utf-8", newline="\n") as f:
    f.write(
        "import { buildPolicyPrompt } from "
        f"{json.dumps(os.path.join(root, 'src/main/automode/rules/policy').replace(os.sep, '/'))}\n"
        "const env = { cwd: 'D:\\\\WorkPlace\\\\ClaudeUI', platform: 'win32',\n"
        "  remotes: [{ name: 'origin', url: 'git@github.com:acme/app.git' }],\n"
        "  repoVisibility: 'private' }\n"
        "await Bun.write(process.argv[2], buildPolicyPrompt(env))\n"
    )
for out in (out_a, out_b):
    subprocess.run(["bun", render, out], cwd=root, check=True, shell=os.name == "nt")
system = open(out_a, encoding="utf-8").read()
if system != open(out_b, encoding="utf-8").read():
    print("FAIL: buildPolicyPrompt is not byte-stable — nothing downstream can cache it")
    sys.exit(1)
print(f"system prompt: {len(system.encode('utf-8'))} bytes, byte-stable across renders")

# ── Server ────────────────────────────────────────────────────────────────────
password = "x"
auth = "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode()
env = dict(os.environ)
env["OPENCODE_SERVER_PASSWORD"] = password

proc = subprocess.Popen(
    [binary, "serve", "--port", "0", "--hostname", "127.0.0.1"],
    cwd=root,
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
        print(f"\n{spec}")
        print(f"  {'call':>4}  {'latency':>8}  {'in':>7}  {'cacheRead':>9}  {'cacheWrite':>10}  text")
        for n in range(1, calls + 1):
            body = {
                "model": {"providerID": providerID, "modelID": modelID},
                # Identical every call — the whole point. Under --vary-system a
                # marker is spliced in near the FRONT, because a cached prefix
                # only ends where the bytes first differ.
                "system": f"<!-- run {n} -->\n{system}" if vary else system,
                # Different every call, like a real transcript.
                "user": (
                    f"<transcript>observation {n}: the agent ran `git status`.</transcript>\n"
                    "Reply with the single word VERIFIED and nothing else."
                ),
                "maxTokens": 2048,
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
                    payload = json.loads(res.read().decode("utf-8", "replace"))
            except urllib.error.HTTPError as e:
                print(f"  {n:>4}  HTTP {e.code}: {e.read().decode('utf-8','replace')[:300]}")
                failures += 1
                continue
            except Exception as e:  # noqa: BLE001
                print(f"  {n:>4}  EXC: {e}")
                failures += 1
                continue
            usage = payload.get("usage") or {}
            print(
                f"  {n:>4}  {time.time()-started:7.2f}s  "
                f"{usage.get('inputTokens', '-'):>7}  "
                f"{usage.get('cacheReadInputTokens', '-'):>9}  "
                f"{usage.get('cacheWriteInputTokens', '-'):>10}  "
                f"{payload.get('text','')[:40]!r}"
            )
            if payload.get("text", "").strip() != "VERIFIED":
                failures += 1
finally:
    proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()

print("\nFAILURES", failures)
sys.exit(1 if failures else 0)
