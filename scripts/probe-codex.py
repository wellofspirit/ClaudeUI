#!/usr/bin/env python3
"""Isolated, offline model-transport probes for official Codex 0.154.0.

Run with uv --no-config run --no-project --offline scripts/probe-codex.py
--codex PATH --output-dir PATH.
No dependencies. macOS arm64 only; refuses any other binary digest or output root.
"""

import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import queue
import signal
import subprocess
import threading
import time
import traceback


ROOT = Path("/var/folders/3y/dsttymn54px6kwqkhxvhpfnm0000gn/T/opencode/codex-spike").resolve()
BINARY_SHA256 = "4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc"
ARCHIVE_SHA256 = "344310a0a591c1b192e04feff304321a69907c9498baaac331ca7e16ebcef9d7"
SOURCE = "https://github.com/openai/codex/releases/download/rust-v0.154.0/codex-aarch64-apple-darwin.tar.gz"
TIMEOUT = 20
TOOL = {"type": "function", "name": "spike_echo", "description": "Return synthetic spike text", "inputSchema": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"], "additionalProperties": False}}
TOOL_RESULT = {"contentItems": [{"type": "inputText", "text": "synthetic-tool-result"}], "success": True}
TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def stop_process(process):
    # PTY tool children can create their own process groups. Include descendants explicitly.
    descendants = set()
    try:
        snapshot = subprocess.run(["/bin/ps", "-axo", "pid=,ppid="], env={"PATH": "/usr/bin:/bin"}, capture_output=True, text=True, timeout=3, check=True)
        pairs = [tuple(map(int, line.split())) for line in snapshot.stdout.splitlines()]
        parents = {process.pid}
        while parents:
            children = {pid for pid, ppid in pairs if ppid in parents} - descendants
            descendants.update(children)
            parents = children
    finally:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            for pid in descendants:
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                if sig == signal.SIGKILL:
                    raise


def text(value):
    return [{"type": "text", "text": value, "text_elements": []}]


def event(kind, **fields):
    return {"type": "response." + kind, **fields}


def completed():
    return event("completed", response={"id": "resp-spike", "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}})


def answer(value="synthetic-finish", reasoning=False):
    message = {"type": "message", "id": "msg-spike", "role": "assistant", "content": [{"type": "output_text", "text": value}]}
    events = [event("created", response={"id": "resp-spike"})]
    if reasoning:
        item = {"type": "reasoning", "id": "reason-spike", "summary": []}
        events += [event("output_item.added", item=item), event("reasoning_summary_part.added", summary_index=0, part={"type": "summary_text", "text": ""}), event("reasoning_summary_text.delta", delta="synthetic-reasoning", summary_index=0), event("output_item.done", item={**item, "summary": [{"type": "summary_text", "text": "synthetic-reasoning"}]})]
    events += [event("output_item.added", item={**message, "content": []}), event("output_text.delta", delta=value), event("output_item.done", item=message), completed()]
    return events


def function_call(call_id, name="spike_echo", arguments=None, namespace=None):
    item = {"type": "function_call", "call_id": call_id, "name": name, "arguments": json.dumps(arguments or {"value": "synthetic-input"})}
    if namespace:
        item["namespace"] = namespace
    return [event("created", response={"id": "resp-spike"}), event("output_item.done", item=item), completed()]


class Mock:
    def __init__(self, directory):
        self.directory = directory
        self.plans = queue.Queue()
        self.requests = []
        self.errors = []
        self.lock = threading.Lock()
        mock = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                mock.errors.append("Unexpected GET " + self.path)
                self.send_error(404)

            def do_POST(self):
                self.connection.settimeout(TIMEOUT)
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                    if self.path != "/v1/responses" or not 0 < size < 4_000_000:
                        raise ValueError("unexpected path or body size")
                    if self.headers.get("Authorization"):
                        raise ValueError("unexpected authorization header; not recorded")
                    body = json.loads(self.rfile.read(size))
                    with mock.lock:
                        index = len(mock.requests)
                        mock.requests.append(body)
                    write_json(directory / f"request-{index:03}.json", body)
                    events = mock.plans.get(timeout=TIMEOUT)
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    for item in events:
                        self.wfile.write(("event: " + item["type"] + "\ndata: " + json.dumps(item) + "\n\n").encode())
                        self.wfile.flush()
                    self.close_connection = True
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except Exception as exc:
                    mock.errors.append(type(exc).__name__ + ": " + str(exc))
                    self.close_connection = True

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def plan(self, events):
        index = self.plans.qsize()
        write_json(self.directory / f"fixture-{time.monotonic_ns()}-{index}.json", events)
        self.plans.put(events)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(TIMEOUT)


class App:
    def __init__(self, runner, label, experimental=True, overrides=()):
        self.runner = runner
        self.label = label
        self.messages = []
        self.condition = threading.Condition()
        self.next_id = 0
        self.trace = (runner.out / (label + ".jsonl")).open("x")
        self.stderr = (runner.out / (label + ".stderr")).open("x")
        self.process = subprocess.Popen(runner.command(*overrides, "app-server", "--listen", "stdio://"), cwd=runner.cwd, env=runner.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, text=True, start_new_session=True)
        self.record = {"label": label, "pid": self.process.pid, "exit": None}
        runner.processes.append(self.record)
        runner.apps.append(self)
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()
        self.initialized = self.rpc("initialize", {"clientInfo": {"name": "codex_isolated_spike", "version": "0.1"}, "capabilities": {"experimentalApi": experimental}})
        self.send({"method": "initialized"})

    def log(self, direction, message):
        self.trace.write(json.dumps({"time": time.monotonic(), "direction": direction, "message": message}) + "\n")
        self.trace.flush()

    def read(self):
        try:
            for line in self.process.stdout:
                message = json.loads(line)
                with self.condition:
                    self.log("server", message)
                    self.messages.append(message)
                    self.condition.notify_all()
        finally:
            with self.condition:
                self.condition.notify_all()

    def send(self, message):
        with self.condition:
            self.log("client", message)
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def wait(self, predicate, after=0, timeout=TIMEOUT):
        deadline = time.monotonic() + timeout
        with self.condition:
            while True:
                for message in self.messages[after:]:
                    if predicate(message):
                        return message
                remaining = deadline - time.monotonic()
                if remaining <= 0 or self.process.poll() is not None:
                    raise TimeoutError(f"{self.label}: no matching message after {after}; exit={self.process.poll()}")
                self.condition.wait(min(remaining, 0.2))

    def rpc(self, method, params, error=False):
        self.next_id += 1
        request_id = self.next_id
        self.send({"id": request_id, "method": method, "params": params})
        response = self.wait(lambda m: m.get("id") == request_id and "method" not in m)
        if error:
            assert "error" in response, response
            return response["error"]
        assert "result" in response, response
        return response["result"]

    def notification(self, method, after=0, **params):
        return self.wait(lambda m: m.get("method") == method and all(m.get("params", {}).get(k) == v for k, v in params.items()), after)["params"]

    def start(self, **params):
        return self.rpc("thread/start", {"cwd": str(self.runner.cwd), "model": "mock-model", "modelProvider": "spike", **params})["thread"]["id"]

    def turn(self, thread_id, value="synthetic-user", **params):
        return self.rpc("turn/start", {"threadId": thread_id, "input": text(value), **params})["turn"]["id"]

    def finish(self, thread_id, turn_id, after=0, status="completed"):
        result = self.wait(lambda m: m.get("method") == "turn/completed" and m["params"]["threadId"] == thread_id and m["params"]["turn"]["id"] == turn_id, after)["params"]["turn"]
        assert result["status"] == status, result
        return result

    def close(self):
        stop_process(self.process)
        self.record["exit"] = self.process.returncode
        self.reader.join(3)
        self.process.stdin.close()
        self.process.stdout.close()
        self.trace.close()
        self.stderr.close()
        self.runner.apps.remove(self)


class Runner:
    def __init__(self, codex, out):
        self.codex, self.out = codex, out
        self.apps = []
        self.processes = []
        self.results = {}
        self.cwd = out / "cwd"
        self.home = out / "home"
        self.codex_home = self.home / ".codex"
        for directory in [self.cwd, self.codex_home, out / "tmp", out / "schema", out / "http"]:
            directory.mkdir(parents=True)
        self.env = {"HOME": str(self.home), "CODEX_HOME": str(self.codex_home), "TMPDIR": str(out / "tmp"), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "SHELL": "/bin/sh", "LANG": "en_US.UTF-8", "USER": "spike", "LOGNAME": "spike", "RUST_LOG": "warn"}
        self.mock = Mock(out / "http")
        # Block user homes, mounted user data, unrelated temp files, and non-loopback networking.
        self.profile = out / "isolation.sb"
        self.profile.write_text(f'''(version 1)
(allow default)
(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath "/Network") (subpath "/private/var/root"))
(deny file-read-data (require-all (subpath "/private/var/folders") (require-not (subpath "{out}")) (require-not (literal "{self.codex}"))))
(deny file-read-data (subpath "/private/etc/codex"))
(deny file-write*)
(allow file-write* (subpath "{out}") (subpath "/dev"))
(deny network*)
(allow network-outbound (remote ip "localhost:{self.mock.server.server_port}"))
''')
        self.codex_home.joinpath("config.toml").write_text(f'''model = "mock-model"
model_provider = "spike"
approval_policy = "on-request"
approvals_reviewer = "user"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
model_supports_reasoning_summaries = true
model_reasoning_summary = "detailed"
web_search = "disabled"
[model_providers.spike]
name = "Isolated loopback fixture"
base_url = "http://127.0.0.1:{self.mock.server.server_port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 15000
[analytics]
enabled = false
[feedback]
enabled = false
[otel]
exporter = "none"
[features]
apps = false
plugins = false
remote_plugin = false
browser_use = false
computer_use = false
shell_snapshot = false
''')

    def command(self, *args):
        return ["/usr/bin/sandbox-exec", "-f", str(self.profile), str(self.codex), *args]

    def binary_command(self, *args):
        process = subprocess.Popen(self.command(*args), cwd=self.cwd, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            stdout, stderr = process.communicate(timeout=TIMEOUT)
            return {"exit": process.returncode, "stdout": stdout, "stderr": stderr}
        finally:
            stop_process(process)
            process.stdout.close()
            process.stderr.close()

    def probe(self, name, function):
        before = len(self.mock.requests)
        try:
            detail = function()
            self.results[name] = {"status": "observed-gap" if isinstance(detail, dict) and detail.get("gap") else "pass", "detail": detail}
        except InterruptedError:
            raise
        except Exception:
            self.results[name] = {"status": "fail", "detail": traceback.format_exc()}
        self.results[name]["requestRange"] = [before, len(self.mock.requests)]
        print(name + ": " + self.results[name]["status"], flush=True)
        self.report()

    def report(self):
        write_json(self.out / "report.json", {"release": "rust-v0.154.0", "source": SOURCE, "license": "Apache-2.0", "archiveSha256": ARCHIVE_SHA256, "binarySha256": BINARY_SHA256, "environmentKeys": sorted(self.env), "probes": self.results, "processes": self.processes, "mockErrors": self.mock.errors, "modelRequests": len(self.mock.requests), "unusedFixtures": self.mock.plans.qsize()})

    def run(self):
        version = self.binary_command("--version")
        write_json(self.out / "version-check.json", version)
        assert version["exit"] == 0, version
        assert version["stdout"].strip() == "codex-cli 0.154.0", version
        schema = self.binary_command("app-server", "generate-json-schema", "--experimental", "--out", str(self.out / "schema"))
        write_json(self.out / "binary-check.json", {"version": version, "schema": schema})
        assert schema["exit"] == 0, schema

        def unauthenticated():
            app = App(self, "unauthenticated", overrides=("-c", 'model_provider="openai"'))
            account = app.rpc("account/read", {"refreshToken": False})
            assert account == {"account": None, "requiresOpenaiAuth": True}, account
            app.close()
            assert not self.mock.requests
            return account
        self.probe("unauthenticated-account-no-refresh", unauthenticated)

        def stable():
            app = App(self, "stable", False)
            account = app.rpc("account/read", {"refreshToken": False})
            assert account["account"] is None, account
            rejected = app.rpc("thread/start", {"cwd": str(self.cwd), "dynamicTools": [TOOL]}, error=True)
            assert "experimental" in rejected["message"].lower(), rejected
            thread = app.start()
            app.close()
            return {"account": account, "experimentalRejection": rejected, "thread": thread}
        self.probe("stable-initialize-account-gating", stable)
        app = App(self, "experimental")

        def experimental_account():
            account = app.rpc("account/read", {"refreshToken": False})
            assert account == {"account": None, "requiresOpenaiAuth": False}, account
            return {"initialize": app.initialized, "account": account}
        self.probe("experimental-initialize-account", experimental_account)
        state = {}

        def streaming():
            thread = app.start(dynamicTools=[TOOL])
            state["thread"] = thread
            self.mock.plan(function_call("dynamic-roundtrip"))
            self.mock.plan(answer(reasoning=True))
            mark = len(app.messages)
            turn = app.turn(thread, clientUserMessageId="spike-user-roundtrip")
            request = app.wait(lambda m: m.get("method") == "item/tool/call", mark)
            assert request["params"]["tool"] == TOOL["name"], request
            app.send({"id": request["id"], "result": TOOL_RESULT})
            app.finish(thread, turn, mark)
            methods = [m.get("method") for m in app.messages[mark:]]
            assert "item/agentMessage/delta" in methods, methods
            assert "item/reasoning/summaryTextDelta" in methods, methods
            assert "synthetic-tool-result" in json.dumps(self.mock.requests[-1]["input"])
            history = app.rpc("thread/read", {"threadId": thread, "includeTurns": True})["thread"]
            live_items = [m["params"]["item"] for m in app.messages[mark:] if m.get("method") == "item/completed" and m["params"]["turnId"] == turn]
            assert [i["id"] for i in live_items] == [i["id"] for i in history["turns"][0]["items"]]
            live_tool = next(i for i in live_items if i["type"] == "dynamicToolCall")
            assert live_tool["success"] is True and live_tool["contentItems"] == TOOL_RESULT["contentItems"], live_tool
            write_json(self.out / "history-live.json", history)
            state.update(turn=turn, history=history)
            return {"thread": thread, "turn": turn, "methods": sorted(set(m for m in methods if m))}
        self.probe("streaming-reasoning-dynamic-roundtrip", streaming)

        def inline_image():
            thread = app.start(dynamicTools=[TOOL])
            self.mock.plan(function_call("dynamic-image"))
            self.mock.plan(answer("image-finish"))
            turn = app.turn(thread)
            request = app.wait(lambda m: m.get("method") == "item/tool/call" and m["params"]["callId"] == "dynamic-image")
            result = {"success": True, "contentItems": TOOL_RESULT["contentItems"] + [{"type": "inputImage", "imageUrl": TINY_PNG}]}
            app.send({"id": request["id"], "result": result})
            app.finish(thread, turn)
            output = next(i["output"] for i in self.mock.requests[-1]["input"] if i.get("type") == "function_call_output" and i["call_id"] == "dynamic-image")
            assert output[0] == {"type": "input_text", "text": "synthetic-tool-result"}, output
            assert output[1]["type"] == "input_image" and output[1]["image_url"] == TINY_PNG, output
            return {"modelOutput": output}
        self.probe("dynamic-inline-image-roundtrip", inline_image)

        def steer():
            thread = app.start(dynamicTools=[TOOL])
            self.mock.plan(function_call("dynamic-steer"))
            self.mock.plan(answer("steered-finish"))
            turn = app.turn(thread)
            request = app.wait(lambda m: m.get("method") == "item/tool/call" and m["params"]["callId"] == "dynamic-steer")
            wrong = app.rpc("turn/steer", {"threadId": thread, "input": text("wrong-steer"), "expectedTurnId": "wrong-id", "clientUserMessageId": "wrong-client-id"}, error=True)
            assert wrong["code"] == -32600, wrong
            result = app.rpc("turn/steer", {"threadId": thread, "input": text("correct-steer"), "expectedTurnId": turn, "clientUserMessageId": "steer-client-id"})
            assert result["turnId"] == turn
            app.send({"id": request["id"], "result": TOOL_RESULT})
            app.finish(thread, turn)
            inactive = app.rpc("turn/steer", {"threadId": thread, "input": text("inactive-steer"), "expectedTurnId": turn, "clientUserMessageId": "inactive-client-id"}, error=True)
            assert inactive["code"] == -32600, inactive
            history = app.rpc("thread/read", {"threadId": thread, "includeTurns": True})
            write_json(self.out / "history-steer.json", history)
            emitted = app.wait(lambda m: m.get("method") == "item/completed" and m["params"]["item"].get("clientId") == "steer-client-id")["params"]
            assert emitted["threadId"] == thread and emitted["turnId"] == turn, emitted
            assert emitted["item"]["type"] == "userMessage" and emitted["item"]["clientId"] == "steer-client-id" and emitted["item"]["content"] == text("correct-steer"), emitted
            assert history["thread"]["id"] == thread and len(history["thread"]["turns"]) == 1, history
            assert history["thread"]["turns"][0]["id"] == turn, history
            assert emitted["item"] in history["thread"]["turns"][0]["items"], history
            assert "correct-steer" in json.dumps(self.mock.requests[-1]["input"])
            assert "wrong-steer" not in json.dumps(history) and "inactive-steer" not in json.dumps(history)
            return {"wrongId": wrong, "noActive": inactive, "accepted": result, "emittedUserItem": emitted, "historyTurnCount": 1}
        self.probe("steer-preconditions-and-client-id", steer)

        def interrupt():
            thread = app.start(dynamicTools=[TOOL])
            self.mock.plan(function_call("dynamic-interrupt"))
            mark = len(app.messages)
            turn = app.turn(thread)
            request = app.wait(lambda m: m.get("method") == "item/tool/call" and m["params"]["callId"] == "dynamic-interrupt", mark)
            app.rpc("turn/interrupt", {"threadId": thread, "turnId": turn})
            app.finish(thread, turn, mark, "interrupted")
            try:
                resolved = app.wait(lambda m: m.get("method") == "serverRequest/resolved" and m["params"].get("requestId") == request["id"], mark, timeout=2)["params"]
            except TimeoutError:
                resolved = None
            completed_tool_present = any(m.get("method") == "item/completed" and m["params"].get("threadId") == thread and m["params"].get("turnId") == turn and m["params"]["item"]["id"] == "dynamic-interrupt" for m in app.messages[mark:])
            before = len(self.mock.requests)
            app.send({"id": request["id"], "result": TOOL_RESULT})
            time.sleep(0.3)
            account = app.rpc("account/read", {"refreshToken": False})
            assert len(self.mock.requests) == before
            history = app.rpc("thread/read", {"threadId": thread, "includeTurns": True})
            write_json(self.out / "history-interrupted.json", history)
            assert "synthetic-tool-result" not in json.dumps(history)
            state["interruptedThread"] = thread
            interrupted_tool_present = any(i["id"] == "dynamic-interrupt" for i in history["thread"]["turns"][0]["items"])
            self.mock.plan(answer("post-interrupt-finish"))
            next_turn = app.turn(thread, "post-interrupt-user")
            app.finish(thread, next_turn)
            assert "synthetic-tool-result" not in json.dumps(self.mock.requests[before])
            return {"gap": None if resolved and completed_tool_present else "Missing serverRequest/resolved or completed dynamic tool item at the bounded post-interrupt check", "resolved": resolved, "completedToolItemPresent": completed_tool_present, "immediateInterruptedToolPresent": interrupted_tool_present, "lateResultAbsentFromNextModelRequest": True, "lateReply": "no new model request over 300ms; subsequent RPC and new turn succeeded; late result absent from history and next model request", "account": account}
        self.probe("pending-dynamic-interrupt-late-reply", interrupt)

        def cold():
            thread = state["thread"]
            app.close()
            cold_app = App(self, "cold")
            state["coldApp"] = cold_app
            interrupted = cold_app.rpc("thread/read", {"threadId": state["interruptedThread"], "includeTurns": True})
            write_json(self.out / "history-interrupted-cold.json", interrupted)
            interrupted_tool_present = any(i["id"] == "dynamic-interrupt" for t in interrupted["thread"]["turns"] for i in t["items"])
            read = cold_app.rpc("thread/read", {"threadId": thread, "includeTurns": True})["thread"]
            resume = cold_app.rpc("thread/resume", {"threadId": thread})["thread"]
            write_json(self.out / "history-cold-read.json", read)
            write_json(self.out / "history-cold-resume.json", resume)
            live_items = state["history"]["turns"][0]["items"]
            read_items = read["turns"][0]["items"]
            resume_items = resume["turns"][0]["items"]
            fidelity = {"coldReadExactItems": live_items == read_items, "resumeExactItems": live_items == resume_items, "liveIds": [i["id"] for i in live_items], "coldIds": [i["id"] for i in read_items], "resumeIds": [i["id"] for i in resume_items]}
            self.mock.plan(function_call("dynamic-resumed"))
            self.mock.plan(answer("resumed-finish"))
            turn = cold_app.turn(thread, "invoke persisted tool")
            request = cold_app.wait(lambda m: m.get("method") == "item/tool/call" and m["params"]["callId"] == "dynamic-resumed")
            cold_app.send({"id": request["id"], "result": TOOL_RESULT})
            cold_app.finish(thread, turn)
            assert any(t.get("name") == TOOL["name"] for t in self.mock.requests[-1]["tools"])
            return {**fidelity, "interruptedToolPresentInColdRead": interrupted_tool_present, "dynamicDefinitionPersistedAndCallable": True, "gap": None if live_items == read_items == resume_items else "History item fidelity changed across cold process restart"}
        self.probe("cold-read-resume-tool-persistence", cold)
        active = state.get("coldApp", app)

        def fork():
            thread = state["thread"]
            before = active.rpc("thread/read", {"threadId": thread, "includeTurns": True})["thread"]
            forked = active.rpc("thread/fork", {"threadId": thread, "lastTurnId": state["turn"]})["thread"]
            write_json(self.out / "history-fork.json", forked)
            assert forked["id"] != thread
            assert len(forked["turns"]) == 1, forked
            assert forked["turns"][0]["id"] == state["turn"], forked
            self.mock.plan(answer("fork-only-finish"))
            turn = active.turn(forked["id"], "fork-only-user")
            active.finish(forked["id"], turn)
            after = active.rpc("thread/read", {"threadId": thread, "includeTurns": True})["thread"]
            assert before["turns"] == after["turns"]
            return {"source": thread, "fork": forked["id"], "sourceTurnsUnchanged": True, "forkInitialTurns": len(forked["turns"])}
        self.probe("fork-completed-last-turn-source-unchanged", fork)

        def approval(decision):
            sentinel = self.cwd / (decision + ".sentinel")
            thread = active.start(approvalPolicy="untrusted", sandbox="workspace-write")
            command = "printf spike-native > " + sentinel.name + "; cat " + sentinel.name
            self.mock.plan(function_call("command-" + decision, "exec_command", {"cmd": command, "shell": "/bin/sh", "login": False, "workdir": str(self.cwd), "yield_time_ms": 1000}))
            self.mock.plan(answer("command-finish"))
            mark = len(active.messages)
            turn = active.turn(thread)
            request = active.wait(lambda m: m.get("method") == "item/commandExecution/requestApproval", mark)
            assert not sentinel.exists()
            active.send({"id": request["id"], "result": {"decision": decision}})
            active.finish(thread, turn, mark)
            resolved = active.notification("serverRequest/resolved", mark, requestId=request["id"])
            assert sentinel.exists() == (decision == "accept")
            if decision == "accept":
                assert sentinel.read_text() == "spike-native"
                execution = active.wait(lambda m: m.get("method") == "item/completed" and m["params"]["item"]["id"] == "command-accept", mark)["params"]["item"]
                assert execution["exitCode"] == 0 and execution["aggregatedOutput"] == "spike-native", execution
            return {"request": request, "resolved": resolved, "sentinelExists": sentinel.exists(), "nativePolicy": "untrusted", "sandbox": "workspace-write"}
        self.probe("native-command-deny", lambda: approval("decline"))
        self.probe("native-command-accept", lambda: approval("accept"))

        def native_queue():
            thread = active.start(dynamicTools=[TOOL])
            self.mock.plan(function_call("dynamic-queue"))
            self.mock.plan(answer("queue-first-finish"))
            self.mock.plan(answer("queue-second-finish"))
            mark = len(active.messages)
            turn = active.turn(thread, "queue-first-user")
            request = active.wait(lambda m: m.get("method") == "item/tool/call" and m["params"]["callId"] == "dynamic-queue", mark)
            added = active.rpc("thread/queue/add", {"threadId": thread, "input": text("queue-second-user"), "clientUserMessageId": "queue-client-id"})
            listed = active.rpc("thread/queue/list", {"threadId": thread})
            assert len(listed["data"]) == 1, listed
            rejected = active.rpc("thread/queue/start", {"threadId": thread}, error=True)
            assert rejected["code"] == -32600, rejected
            active.send({"id": request["id"], "result": TOOL_RESULT})
            active.finish(thread, turn, mark)
            time.sleep(0.3)
            idle_list = active.rpc("thread/queue/list", {"threadId": thread})
            auto_started = not idle_list["data"]
            if not auto_started:
                second = active.rpc("thread/queue/start", {"threadId": thread})["turn"]["id"]
            else:
                second = active.wait(lambda m: m.get("method") == "turn/started" and m["params"]["threadId"] == thread and m["params"]["turn"]["id"] != turn, mark)["params"]["turn"]["id"]
            active.finish(thread, second, mark)
            assert second != turn
            assert not active.rpc("thread/queue/list", {"threadId": thread})["data"]
            history = active.rpc("thread/read", {"threadId": thread, "includeTurns": True})["thread"]
            write_json(self.out / "history-queue.json", history)
            assert len(history["turns"]) == 2, history
            assert history["turns"][1]["items"][0]["clientId"] == "queue-client-id", history
            assert "queue-second-user" not in json.dumps(self.mock.requests[-2]["input"])
            return {"queued": added, "activeStartRejected": rejected, "autoStartedWithin300ms": auto_started, "turnIds": [turn, second], "gap": None if auto_started else "Auto-start not observed at queue read after 300ms wait; explicit start used for investigation"}
        self.probe("native-queue-next-turn", native_queue)

        def child_observation():
            thread = active.start()
            self.mock.plan(function_call("spawn-child", "spawn_agent", {"message": "synthetic-native-child-user"}, namespace="multi_agent_v1"))
            # Child and parent requests race. Both receive the same harmless terminal answer.
            self.mock.plan(answer("synthetic-native-child-finish"))
            self.mock.plan(answer("synthetic-native-child-finish"))
            mark = len(active.messages)
            turn = active.turn(thread, "synthetic-native-parent-user")
            active.finish(thread, turn, mark)
            spawn = active.wait(lambda m: m.get("method") == "item/completed" and m["params"]["item"]["id"] == "spawn-child", mark)["params"]["item"]
            write_json(self.out / "child-spawn-item.json", spawn)
            children = active.rpc("thread/list", {"parentThreadId": thread, "sourceKinds": ["subAgentThreadSpawn"], "limit": 10})
            write_json(self.out / "child-list.json", children)
            assert len(children["data"]) == 1, children
            child_id = children["data"][0]["id"]
            assert spawn["status"] == "completed" and spawn["receiverThreadIds"] == [child_id], spawn
            deadline = time.monotonic() + TIMEOUT
            while True:
                child = active.rpc("thread/read", {"threadId": child_id, "includeTurns": True})["thread"]
                if child["turns"] and child["turns"][-1]["status"] == "completed":
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError("native child did not complete")
                time.sleep(0.1)
            write_json(self.out / "history-child.json", child)
            assert "synthetic-native-child-finish" in json.dumps(child)
            child_notifications = [m["method"] for m in active.messages[mark:] if m.get("params", {}).get("threadId") == child_id and "method" in m]
            assert child["source"]["subAgent"]["thread_spawn"]["parent_thread_id"] == thread
            assert {"item/agentMessage/delta", "turn/completed"}.issubset(child_notifications), child_notifications
            return {"mode": "multi_agent_v1", "parentId": thread, "childId": child_id, "source": child["source"], "spawnItem": spawn, "childNotificationMethods": sorted(set(child_notifications)), "childReadCompleted": True}
        self.probe("native-child-observation", child_observation)
        self.report()

    def close(self):
        for app in list(self.apps):
            try:
                app.close()
            except Exception:
                self.results["cleanup-" + app.label] = {"status": "fail", "detail": traceback.format_exc()}
        try:
            self.mock.close()
        finally:
            self.report()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if not __debug__:
        parser.error("Probe assertions require Python without optimization")
    codex, out = args.codex.resolve(), args.output_dir.resolve()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        parser.error("This spike requires macOS arm64 and sandbox-exec")
    if not codex.is_relative_to(ROOT) or not out.is_relative_to(ROOT) or out == ROOT:
        parser.error("Binary and output must be under the approved codex-spike temporary root")
    if out.exists():
        parser.error("Output directory must not exist; use a fresh run directory")
    if not out.parent.is_dir():
        parser.error("Output parent must already exist")
    if hashlib.sha256(codex.read_bytes()).hexdigest() != BINARY_SHA256:
        parser.error("Binary digest does not match the verified official 0.154.0 arm64 binary")
    os.umask(0o077)
    out.mkdir()
    def interrupted(signum, _frame):
        raise InterruptedError(f"Probe interrupted by signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(180)
    runner = Runner(codex, out)
    try:
        runner.run()
    except BaseException:
        runner.results["fatal"] = {"status": "fail", "detail": traceback.format_exc()}
        raise
    finally:
        signal.alarm(0)
        runner.close()
    return int(any(p["status"] == "fail" for p in runner.results.values()) or bool(runner.mock.errors) or not runner.mock.plans.empty())


if __name__ == "__main__":
    raise SystemExit(main())
