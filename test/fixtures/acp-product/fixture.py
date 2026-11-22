import http.server
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid


run = Path(os.environ["FIXTURE_RUN"])


def record(name, data):
    (run / name).write_text(json.dumps(data))


def post(url, headers, body):
    request = urllib.request.Request(
        url, json.dumps(body).encode(), {"Content-Type": "application/json", **headers}
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


def out(**frame):
    print(json.dumps({"jsonrpc": "2.0", **frame}), flush=True)


def read():
    line = sys.stdin.readline()
    return json.loads(line) if line else None


def update(session, **data):
    out(method="session/update", params={"sessionId": session, "update": data})


if sys.argv[1] == "sidecar":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)

    class Health(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200 if self.path == "/ready" else 404)
            self.end_headers()

    with http.server.HTTPServer(("127.0.0.1", int(sys.argv[2])), Health) as server:
        record("sidecar.json", os.getpid())
        server.serve_forever()
    sys.exit(0)

background = subprocess.Popen([sys.executable, "-c", "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(120)"], start_new_session=True)
record("pids.json", [os.getpid(), background.pid])
print("fixture diagnostic", file=sys.stderr, flush=True)
session = None
mcp = None
supports_load = os.environ.get("FIXTURE_LOAD", "1") == "1"
for incoming in iter(read, None):
    method = incoming["method"]
    params = incoming["params"]
    request_id = incoming.get("id")
    if method == "initialize":
        assert params["protocolVersion"] == 1 and params["clientCapabilities"] == {}
        out(id=request_id, result={"protocolVersion": 1, "agentCapabilities": {"loadSession": supports_load, "sessionCapabilities": {"close": {}}}})
    elif method in ("session/new", "session/load"):
        assert params["cwd"] == os.getcwd() and len(params["mcpServers"]) == 1
        mcp = params["mcpServers"][0]
        assert mcp["type"] == "http" and mcp["url"].startswith("http://127.0.0.1:")
        if method == "session/load":
            session = params["sessionId"]
            if not (Path.home() / session).exists():
                out(id=request_id, error={"code": -32602, "message": "session missing"})
                continue
        else:
            session = str(uuid.uuid4())
            (Path.home() / session).touch()
        record("session.json", {"method": method, "session": session})
        out(id=request_id, result={"sessionId": session} if method == "session/new" else {})
    elif method == "session/close":
        assert params["sessionId"] == session
        record("close.json", True)
        out(id=request_id, result={})
    elif method == "session/prompt":
        assert params["sessionId"] == session
        text = params["prompt"][0]["text"]
        record("prompt.json", text)
        if text.endswith("bad stdout"):
            print("fixture log on stdout", flush=True)
            continue
        if text.endswith("error"):
            out(id=request_id, error={"code": -32603, "message": "fixture prompt error"})
            continue
        if text.endswith("hold"):
            instruction = read()
            assert instruction["method"] == "session/cancel" and instruction["params"]["sessionId"] == session
            record("cancel.json", True)
            out(id=request_id, result={"stopReason": "cancelled"})
            time.sleep(120)
            continue
        update(session, sessionUpdate="tool_call", toolCallId="T", title="read facts", status="pending")
        out(id="approval", method="session/request_permission", params={"sessionId": session, "toolCall": {"toolCallId": "T"}, "options": [
            {"kind": "reject_once", "optionId": "reject"}, {"kind": "allow_once", "optionId": "allow"}
        ]})
        assert read()["result"]["outcome"] == {"outcome": "selected", "optionId": "allow"}
        out(id=743, method="_fixture/input", params={"sessionId": session})
        assert read()["result"] == {"answer": "unattended"}
        out(id=744, method="fs/read_text_file", params={"sessionId": session})
        assert read()["error"]["code"] == -32601
        headers = {item["name"]: item["value"] for item in mcp["headers"]}

        def call(call_id, method, **args):
            return post(mcp["url"], headers, {"jsonrpc": "2.0", "id": call_id, "method": method, "params": args})["result"]

        try:
            post(mcp["url"], {"Authorization": "Bearer invalid"}, {"jsonrpc": "2.0", "id": 0, "method": "tools/list"})
            raise AssertionError("MCP accepted a mismatched token")
        except urllib.error.HTTPError as error:
            assert error.code == 401
        assert call(1, "initialize", protocolVersion="2025-06-18")["capabilities"] == {"tools": {}}
        assert {item["name"] for item in call(2, "tools/list")["tools"]} == {"read_fact", "finish"}
        fact = json.loads(call(3, "tools/call", name="read_fact")["content"][0]["text"])["fact"]
        response = post(os.environ["FIXTURE_MODEL_URL"] + "/chat/completions", {"Authorization": "Bearer " + os.environ["FIXTURE_MODEL_TOKEN"]}, {
            "model": os.environ["FIXTURE_MODEL"], "messages": [{"role": "user", "content": fact}]
        })
        assert response["choices"][0]["message"]["content"] == "fixture model"
        update(session, sessionUpdate="agent_message_chunk", content={"type": "text", "text": "检查"})
        update(session, sessionUpdate="agent_message_chunk", content={"type": "text", "text": "完成"})
        update(session, sessionUpdate="tool_call_update", toolCallId="T", status="completed")
        invalid = call(4, "tools/call", name="finish", arguments={"summary": ""})
        assert invalid["isError"]
        valid = call(5, "tools/call", name="finish", arguments={"summary": fact})
        assert not valid["isError"]
        out(id=request_id, result={"stopReason": "end_turn"})
    else:
        out(id=request_id, error={"code": -32601, "message": "method absent"})
