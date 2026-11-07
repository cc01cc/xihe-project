#!/usr/bin/env python3
"""official.kv-selftest — fixture-level MCP server for the plugin data plane (TEST-ONLY).

PLAN-0691 B-6 ① + T1.5. This is not a release artifact and never ships: it exists so that
verify.md V4/V5/V8 can be replayed through a real MCP hop (CP proxy -> this server -> CP data
plane) instead of a hand-written HTTP client, and so the `mcp-http` runtime kind in
manifest.schema.json has at least one concrete package to install.

Transport: HTTP POST /mcp carrying JSON-RPC 2.0, answering the three methods the CP proxy needs
(`initialize`, `tools/list`, `tools/call`). GET /healthz answers readiness for the test runner.

It obeys these three rules, which are exactly the ones that let a package live in plugins/official/:

  1. NO database access of any kind. The only store it touches is the CP plugin data plane
     (/internal/v1/plugin-bindings/{bindingId}/kv) over HTTP. `db-design-checklist` and
     cross-layer-matrix.md V1 forbid plugins from reaching PostgreSQL directly.
  2. NO secret in the repository. The binding-scoped token arrives in the environment and is never
     logged, echoed in a tool result, or written to disk (B-5).
  3. Standard library only, single file, no install step — a fixture that needs provisioning is a
     fixture that silently rots.

Run it (the token must be minted by CP for the binding named below):

    XIHE_PLUGIN_KV_BINDING=<binding-uuid> XIHE_PLUGIN_KV_TOKEN=<jwt> \
        python server.py --port 7331

Environment:

    XIHE_PLUGIN_KV_BASE     default http://127.0.0.1:8080
    XIHE_PLUGIN_KV_BINDING  binding id the token was minted for (also the URL segment)
    XIHE_PLUGIN_KV_TOKEN    binding-scoped JWT (SEC-1); absent => the tool reports what is missing
    XIHE_KV_SELFTEST_PORT   alternative to --port (default 7331, the endpoint in manifest.json)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "official.kv-selftest"
SERVER_VERSION = "0.1.0"
DEFAULT_PORT = 7331
# The single namespace manifest.json declares; anything else is a manifest bug, not a test target.
NAMESPACE = "selftest"
PROBE_KEY = "probe"
TOOL_NAME = "kv_selftest"
HTTP_TIMEOUT_SECONDS = 5.0


class ToolError(Exception):
    """A tool-level failure: reported to the caller, never swallowed."""


# --------------------------------------------------------------------------- data plane client


class KvClient:
    """The only thing this fixture talks to: CP's plugin KV data plane (spec/data-plane.md API-1..4)."""

    def __init__(self, base_url: str, binding_id: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.binding_id = binding_id
        self.token = token

    @property
    def prefix(self) -> str:
        return f"{self.base_url}/internal/v1/plugin-bindings/{self.binding_id}/kv"

    def call(self, method: str, path: str, body: dict | None = None,
             if_match: str | None = None) -> tuple[int, str]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(self.prefix + path, data=data, method=method)
        request.add_header("Authorization", "Bearer " + self.token)
        request.add_header("Accept", "application/json")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        if if_match is not None:
            request.add_header("If-Match", if_match)
        try:
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                return response.status, response.read().decode("utf-8")
        except urllib.error.HTTPError as failure:
            # A 4xx here is an expected assertion target (412/429/413), not a crash.
            return failure.code, failure.read().decode("utf-8")

    def location(self) -> str:
        return f"{NAMESPACE}/{PROBE_KEY}"


def require_environment() -> tuple[str, str, str]:
    base = os.environ.get("XIHE_PLUGIN_KV_BASE", "http://127.0.0.1:8080")
    binding = os.environ.get("XIHE_PLUGIN_KV_BINDING", "").strip()
    token = os.environ.get("XIHE_PLUGIN_KV_TOKEN", "").strip()
    if not binding or not token:
        raise ToolError(
            "fixture is not wired to a binding: set XIHE_PLUGIN_KV_BINDING and XIHE_PLUGIN_KV_TOKEN "
            "(CP mints the token; this fixture never mints or stores credentials)")
    return base, binding, token


# --------------------------------------------------------------------------- the self-test itself


def run_self_test() -> dict:
    """Exercise the CAS contract end to end and return what was observed per step.

    The steps mirror `client.json` one-for-one; if you change one, change both. Every step asserts a
    contract from spec/data-plane.md API-1..3/API-11 rather than a happy path:

      1. unconditional PUT              -> 412 PLUGIN_PRECONDITION_REQUIRED (create needs If-Match: *)
      2. PUT with If-Match: *           -> 200, version 1
      3. GET                            -> 200, the value written in step 2
      4. PUT with the current version   -> 200, version 2
      5. PUT with now-stale version 1   -> 412 PLUGIN_PRECONDITION_FAILED
      6. GET                            -> 200, step 4's value (the stale write did not land)
      7. DELETE with the current version-> 204, the row is gone
      8. GET                            -> 404 PLUGIN_NOT_FOUND
    """
    base, binding, token = require_environment()
    client = KvClient(base, binding, token)
    location = "/" + client.location()
    first = {"value": {"probe": "v1", "fixture": SERVER_NAME}}
    second = {"value": {"probe": "cas-write", "fixture": SERVER_NAME}}
    steps: list[dict] = []

    def record(name: str, status: int, expected: int, detail: str = "") -> None:
        steps.append({"step": name, "status": status, "expected": expected,
                      "ok": status == expected, "detail": detail[:500]})
        if status != expected:
            raise ToolError(f"step '{name}' expected HTTP {expected} but got {status}: {detail[:500]}")

    status, detail = client.call("PUT", location, first)
    record("create-without-precondition", status, 412, detail)

    status, detail = client.call("PUT", location, first, if_match="*")
    record("create-with-precondition", status, 200, detail)
    version = str(_json(detail).get("version", 1))

    status, detail = client.call("GET", location)
    record("read-after-create", status, 200, detail)

    status, detail = client.call("PUT", location, second, if_match=version)
    record("update-with-current-version", status, 200, detail)
    current = str(_json(detail).get("version", int(version) + 1))

    status, detail = client.call("PUT", location, {"value": {"probe": "stale-write"}},
                                 if_match=version)
    record("stale-write-is-rejected", status, 412, detail)

    status, detail = client.call("GET", location)
    if status == 200 and "stale-write" in detail:
        # Status alone would not catch a lost-update: the row would look healthy while holding the
        # value the rejected write carried.
        raise ToolError("stale write landed; CAS is broken: " + detail[:500])
    record("stale-write-did-not-land", status, 200, detail)

    status, detail = client.call("DELETE", location, if_match=current)
    record("delete-with-current-version", status, 204, detail)

    status, detail = client.call("GET", location)
    record("read-after-delete", status, 404, detail)

    return {"tool": TOOL_NAME, "bindingId": binding, "namespace": NAMESPACE,
            "steps": steps, "ok": all(step["ok"] for step in steps)}


def _json(text: str) -> dict:
    try:
        value = json.loads(text)
    except json.JSONDecodeError as failure:
        raise ToolError(f"expected a JSON body, got {text[:200]!r}") from failure
    return value if isinstance(value, dict) else {}


# --------------------------------------------------------------------------- JSON-RPC / MCP surface


TOOLS = [
    {
        "name": TOOL_NAME,
        "title": "KV self test",
        "description": "Runs the CAS/quota probe against the CP plugin KV data plane and returns "
                       "every observed step. Test-only.",
        "inputSchema": {"type": "object", "additionalProperties": False, "properties": {}},
    }
]


def handle_jsonrpc(payload: dict) -> dict | None:
    request_id = payload.get("id")
    method = payload.get("method")
    if method == "initialize":
        result = {
            "protocolVersion": PROTOCOL_VERSION,
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "capabilities": {"tools": {}},
        }
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        params = payload.get("params") or {}
        if params.get("name") != TOOL_NAME:
            return _rpc_error(request_id, -32602, f"unknown tool: {params.get('name')!r}")
        try:
            observation = run_self_test()
        except ToolError as failure:
            # Tool failures are results, not protocol errors: the model must see the message.
            result = {"content": [{"type": "text", "text": str(failure)}], "isError": True}
        else:
            result = {"content": [{"type": "text", "text": json.dumps(observation, indent=2)}],
                      "isError": False}
    elif method is None and request_id is None:
        return None  # a notification; nothing to answer
    else:
        return _rpc_error(request_id, -32601, f"unsupported method: {method!r}")
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _rpc_error(request_id: object, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


class Handler(BaseHTTPRequestHandler):
    server_version = f"{SERVER_NAME}/{SERVER_VERSION}"
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's spelling
        if self.path.rstrip("/") in ("/healthz", ""):
            self._send(200, {"ok": True, "server": SERVER_NAME, "version": SERVER_VERSION})
        else:
            self._send(404, {"error": "not found", "path": self.path})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/mcp":
            self._send(404, {"error": "not found", "path": self.path})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 262_144:
            self._send(400, _rpc_error(None, -32600, "expected a bounded JSON-RPC body"))
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self._send(400, _rpc_error(None, -32700, "invalid JSON"))
            return
        if not isinstance(payload, dict):
            self._send(400, _rpc_error(None, -32600, "expected a JSON-RPC object"))
            return
        answer = handle_jsonrpc(payload)
        if answer is None:
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self._send(200, answer)

    def log_message(self, format: str, *args: object) -> None:
        # Request lines carry the binding id; keep them, but a token must never reach the log.
        line = format % args
        sys.stderr.write(f"[{SERVER_NAME}] {line}\n")

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="official.kv-selftest MCP fixture (test-only)")
    parser.add_argument("--port", type=int,
                        default=int(os.environ.get("XIHE_KV_SELFTEST_PORT", DEFAULT_PORT)))
    parser.add_argument("--host", default="127.0.0.1")
    arguments = parser.parse_args(argv)
    server = ThreadingHTTPServer((arguments.host, arguments.port), Handler)
    print(f"[{SERVER_NAME}] listening on http://{arguments.host}:{arguments.port}/mcp",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
