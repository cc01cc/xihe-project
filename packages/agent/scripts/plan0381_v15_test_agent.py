"""PLAN-0381 V15 test Agent service: production FastAPI route + local provider wire fixture.

The CP ChatController calls this real `/internal/v1/agent/chat` route. Only the
provider HTTP endpoint and the credential-readiness seam are test fixtures; the
Agent runner, MCP client, CP EventStore, streamed AgentEvents/SSE, CP Operation
ledger, and Runtime tool execution remain real.
"""

from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import uvicorn

MAX_REQUEST_BYTES = 4 * 1024 * 1024
MAX_RESPONSE_BYTES = 128 * 1024
IO_TIMEOUT_SECONDS = 60


class ProviderFixture(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, capture_path: Path) -> None:
        self.capture_path = capture_path
        self.lock = threading.Lock()
        self.request_number = 0
        self.requests: list[dict[str, Any]] = []
        super().__init__(("127.0.0.1", 0), _ProviderHandler)

    def capture(self, body: dict[str, Any]) -> int:
        with self.lock:
            self.request_number += 1
            self.requests.append(body)
            self.capture_path.parent.mkdir(parents=True, exist_ok=True)
            with self.capture_path.open("a", encoding="utf-8", newline="\n") as stream:
                stream.write(json.dumps(body, ensure_ascii=False, separators=(",", ":")) + "\n")
                stream.flush()
            return self.request_number


class _ProviderHandler(BaseHTTPRequestHandler):
    server: ProviderFixture

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(IO_TIMEOUT_SECONDS)

    def do_POST(self) -> None:
        if self.path.rstrip("/") not in ("/v1/chat/completions", "/chat/completions"):
            self._json_error(404, "unknown fixture endpoint")
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > MAX_REQUEST_BYTES:
                self._json_error(413, "invalid request size")
                return
            request = json.loads(self.rfile.read(size))
            if not isinstance(request, dict):
                self._json_error(400, "request must be an object")
                return
            number = self.server.capture(request)
            chunks = self._chunks(request, number)
            body = b"".join(f"data: {json.dumps(chunk, separators=(',', ':'))}\n\n".encode() for chunk in chunks)
            body += b"data: [DONE]\n\n"
            if len(body) > MAX_RESPONSE_BYTES:
                self._json_error(500, "fixture response exceeded bound")
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
        except (OSError, TimeoutError):
            return
        except (ValueError, json.JSONDecodeError) as exc:
            self._json_error(400, str(exc))

    @staticmethod
    def _chunks(request: dict[str, Any], number: int) -> list[dict[str, Any]]:
        common = {
            "id": f"chatcmpl-plan0381-v15-{number}",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": str(request.get("model") or "v15-tool-history"),
        }
        if number == 1:
            tool_name = None
            for item in request.get("tools", []):
                function = item.get("function") if isinstance(item, dict) else None
                name = function.get("name") if isinstance(function, dict) else None
                if isinstance(name, str) and (name == "read_file" or name.endswith("read_file")):
                    tool_name = name
                    break
            if tool_name is None:
                raise ValueError("first provider request did not expose a real read_file tool")
            args = json.dumps({"path": "large.txt"}, separators=(",", ":"))
            return [
                {**common, "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [
                    {"index": 0, "id": "provider-call-v15-1", "type": "function",
                     "function": {"name": tool_name, "arguments": args}}
                ]}, "finish_reason": None}]},
                {**common, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
                {**common, "choices": [], "usage": {"prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10}},
            ]
        final = "v15-first-run-complete" if number == 2 else "v15-next-round-restored-complete"
        return [
            {**common, "choices": [{"index": 0, "delta": {"role": "assistant", "content": final}, "finish_reason": None}]},
            {**common, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            {**common, "choices": [], "usage": {"prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10}},
        ]

    def _json_error(self, status: int, message: str) -> None:
        body = json.dumps({"error": {"message": message}}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def log_message(self, fmt: str, *args: Any) -> None:
        # Do not echo Authorization headers or request bodies to logs.
        return


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"required environment variable {name} is missing")
    return value


def main() -> None:
    cp_url = _required("XIHE_CP_URL")
    service_token = _required("XIHE_CP_API_TOKEN")
    os.environ["XIHE_CP_URL"] = cp_url.rstrip("/")
    os.environ["XIHE_CP_API_TOKEN"] = service_token
    agent_port = int(_required("XIHE_AGENT_PORT"))
    capture_path = Path(_required("XIHE_V15_PROVIDER_CAPTURE"))
    if not 1 <= agent_port <= 65535:
        raise ValueError("XIHE_AGENT_PORT must be in 1..65535")

    provider = ProviderFixture(capture_path)
    provider_thread = threading.Thread(target=provider.serve_forever, name="v15-openai-fixture", daemon=True)
    provider_thread.start()

    # Import after env setup so the real Agent clients bind to the H2 CP test app.
    from xihe_agent import main as agent_main
    from xihe_agent.llm.base import LLMConfig, XiheLiteLLM

    fake_config = LLMConfig(
        provider="openai",
        route_provider="openai",
        api_key="sk-v15-local-fixture",
        api_base=f"http://127.0.0.1:{provider.server_port}/v1",
        model="v15-tool-history",
        timeout=60,
        max_tokens=1024,
        temperature=0,
    )
    # Provider-only seam. Production chat route, MCP/session/run context,
    # LangGraphRunner, CPEventStore, SSE event conversion and authorization remain real.
    agent_main.create_llm = lambda cfg: XiheLiteLLM(config=fake_config.with_model(cfg.model or fake_config.model))
    agent_main._llm_ready = "ready"
    agent_main._agent_status = "ok"
    # The local provider fixture has no credential lease. Do not patch any Tool/MCP/CP gate.
    agent_main._has_instance_fallback_credentials = lambda _cfg: True

    try:
        uvicorn.run(agent_main.app, host="127.0.0.1", port=agent_port, lifespan="off", log_level="warning")
    finally:
        provider.shutdown()
        provider.server_close()
        provider_thread.join(timeout=IO_TIMEOUT_SECONDS)


if __name__ == "__main__":
    main()
