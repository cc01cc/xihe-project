"""PLAN-0381 M3（T3.3）：真实 provider-compatible message shape。

契约 evidence/m3-contract.md §4 两层断言：
1. 咽喉点层——`to_langchain_messages` → `XiheLiteLLM._create_message_dicts`
   （源码自称 single choke point）产出 OpenAI-dict 形状；
2. 真实 provider 转换层——取同一 message_dicts 直调 `litellm.acompletion`
   （stream=False），本地 TCP fixture 捕获 wire body，分别断言 OpenAI 透传
   与 Anthropic `tool_use`/`tool_result` block 形状。
不 mock 转换层；`status→is_error` 的 provider delta 已按契约登记为现状不支持。
"""

import asyncio
import json
from typing import Any

import litellm
import pytest
from langchain_core.messages import HumanMessage, SystemMessage

import xihe_agent.agent_runner.langgraph_runner as langgraph_runner_module
from xihe_agent.interfaces.message import TextMessage, ToolCallRef
from xihe_agent.llm.base import LLMConfig, XiheLiteLLM

litellm.telemetry = False  # 单测不外呼


def _history_messages() -> list[Any]:
    """一段含配对的历史（human/ai(tool_calls)/tool），经 M1 映射产出。"""
    return langgraph_runner_module.to_langchain_messages(
        [
            TextMessage(
                role="ai",
                content="",
                tool_calls=(
                    ToolCallRef(call_id="c1", tool_name="read_file", arguments={"path": "a.txt"}),
                ),
            ),
            TextMessage(
                role="tool",
                content="file content",
                tool_call_id="c1",
                tool_name="read_file",
                status="completed",
            ),
            TextMessage(role="human", content="next round"),
        ]
    )


def _openai_client(monkeypatch: pytest.MonkeyPatch, api_base: str) -> XiheLiteLLM:
    monkeypatch.setenv("XIHE_LLM_PROVIDER", "openai")
    monkeypatch.setenv("XIHE_OPENAI_API_KEY", "sk-fake")
    monkeypatch.setenv("XIHE_MODEL", "gpt-test")
    monkeypatch.setenv("XIHE_API_BASE", api_base)
    return XiheLiteLLM(config=LLMConfig.from_env())


def _openai_response() -> dict[str, Any]:
    return {
        "id": "chatcmpl-fixture",
        "object": "chat.completion",
        "created": 1,
        "model": "gpt-test",
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


def _anthropic_response() -> dict[str, Any]:
    return {
        "id": "msg-fixture",
        "type": "message",
        "role": "assistant",
        "model": "claude-test",
        "content": [{"type": "text", "text": "ok"}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": 1, "output_tokens": 1},
    }


class _WireCapture:
    """最小 HTTP 捕获 fixture：只绑 127.0.0.1:0，记录请求 body，回放 canned 响应。"""

    def __init__(self, responder: Any) -> None:
        self._responder = responder
        self._server: asyncio.AbstractServer | None = None
        self.requests: list[tuple[str, dict[str, Any], dict[str, str]]] = []
        self.base_url = ""

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        host, port = self._server.sockets[0].getsockname()[:2]
        self.base_url = f"http://{host}:{port}"

    async def stop(self) -> None:
        assert self._server is not None
        self._server.close()
        await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
            lines = head.decode("latin-1").split("\r\n")
            path = lines[0].split(" ")[1] if " " in lines[0] else "/"
            headers = {}
            for line in lines[1:]:
                if ":" in line:
                    key, value = line.split(":", 1)
                    headers[key.strip().lower()] = value.strip()
            length = int(headers.get("content-length", "0"))
            raw = await asyncio.wait_for(reader.readexactly(length), timeout=10) if length else b""
            payload = json.loads(raw) if raw else {}
            self.requests.append((path, payload, headers))
            body = json.dumps(self._responder(path, payload)).encode("utf-8")
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode("latin-1")
                + body
            )
            await writer.drain()
        except Exception:
            pass
        finally:
            writer.close()


# --- 层 1：咽喉点（进程内，无 HTTP）-----------------------------------------


def test_openai_dict_shape_at_llm_choke_point(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _openai_client(monkeypatch, "http://127.0.0.1:9/v1")
    message_dicts, params = client._create_message_dicts(_history_messages(), None)

    assert params["model"] == "openai/gpt-test"  # 路由前缀保持（无静默改写）
    assistant, tool_msg, human = message_dicts
    assert assistant["role"] == "assistant"
    call = assistant["tool_calls"][0]
    assert call["id"] == "c1"
    assert call["type"] == "function"
    assert call["function"]["name"] == "read_file"
    # OpenAI 线：arguments 是 JSON 字符串（provider delta 表）
    assert json.loads(call["function"]["arguments"]) == {"path": "a.txt"}
    assert tool_msg == {"content": "file content", "role": "tool", "tool_call_id": "c1"}
    assert human["role"] == "user"
    # 参数是回放原文，不触发任何工具执行（本路径根本无工具句柄）
    assert "tools" not in params


# --- 层 2：真实 provider 转换（HTTP wire 捕获）------------------------------


@pytest.mark.asyncio
async def test_openai_route_wire_capture_preserves_pairing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _WireCapture(lambda _path, _payload: _openai_response())
    await fixture.start()
    try:
        client = _openai_client(monkeypatch, f"{fixture.base_url}/v1")
        message_dicts, params = client._create_message_dicts(_history_messages(), None)
        response = await litellm.acompletion(
            model=params["model"],
            messages=message_dicts,
            api_base=f"{fixture.base_url}/v1",
            api_key="sk-fake",
            stream=False,
            max_retries=0,
            timeout=10,
        )

        assert len(fixture.requests) == 1
        path, body, _headers = fixture.requests[0]
        assert path.endswith("/chat/completions"), path
        assert "tools" not in body, "历史回放不得携带可执行工具声明"
        wire_assistant, wire_tool, wire_human = body["messages"]
        assert wire_assistant["tool_calls"][0]["id"] == "c1"
        assert wire_assistant["tool_calls"][0]["function"]["name"] == "read_file"
        assert json.loads(wire_assistant["tool_calls"][0]["function"]["arguments"]) == {
            "path": "a.txt"
        }
        assert wire_tool["role"] == "tool"
        assert wire_tool["tool_call_id"] == "c1"
        assert wire_tool["content"] == "file content"
        assert wire_human["role"] == "user"
        # 响应可解析 → 转换管线闭环
        assert response.choices[0].message.content == "ok"
    finally:
        await fixture.stop()


@pytest.mark.asyncio
async def test_anthropic_route_wire_capture_emits_tool_use_blocks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = _WireCapture(lambda _path, _payload: _anthropic_response())
    await fixture.start()
    try:
        client = _openai_client(monkeypatch, f"{fixture.base_url}/v1")
        message_dicts, _params = client._create_message_dicts(_history_messages(), None)
        response = await litellm.acompletion(
            model="anthropic/claude-test",
            messages=message_dicts,
            api_base=fixture.base_url,
            api_key="sk-fake",
            max_tokens=256,
            stream=False,
            max_retries=0,
            timeout=10,
        )

        assert len(fixture.requests) == 1
        path, body, headers = fixture.requests[0]
        assert "messages" in path, path
        assert headers.get("x-api-key") == "sk-fake"
        # 历史回放不得把历史工具（read_file）声明为本请求可执行工具。
        # litellm 会在 anthropic 线为满足「tool_use 必须带 tools」约束注入占位
        # dummy_tool（源码注释：bedrock constraint）——占位可接受，真名不可。
        # tools 必须存在：若 litellm 不再注入，断言转红强制重评（防空集恒真）。
        assert body.get("tools"), "anthropic wire must declare tools for tool_use history"
        declared = {t.get("name", "") for t in body.get("tools") or []}
        assert "read_file" not in declared
        assert all(
            "dummy" in (t.get("name", "") + t.get("description", "")).lower()
            for t in body.get("tools") or []
        ), f"unexpected tool declarations: {declared}"

        # Anthropic 线：assistant content 含 tool_use block（input 为 object）
        assistant = next(m for m in body["messages"] if m["role"] == "assistant" and m["content"])
        tool_use = next(
            block for block in assistant["content"] if block.get("type") == "tool_use"
        )
        assert tool_use["id"] == "c1"
        assert tool_use["name"] == "read_file"
        assert tool_use["input"] == {"path": "a.txt"}  # provider delta：object 而非字符串
        # tool 结果为 tool_result block，tool_use_id 与声明一一配对
        tool_result_msg = next(
            m
            for m in body["messages"]
            if m["role"] == "user"
            and isinstance(m["content"], list)
            and any(b.get("type") == "tool_result" for b in m["content"])
        )
        tool_result = next(
            block for block in tool_result_msg["content"] if block.get("type") == "tool_result"
        )
        assert tool_result["tool_use_id"] == "c1"
        assert "file content" in json.dumps(tool_result["content"])
        # 契约 §4 delta 表：litellm 链不产 is_error —— 登记现状，不以 mock 伪造
        assert response.choices[0].message.content == "ok"
    finally:
        await fixture.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("provider_model", ["openai/gpt-test", "anthropic/claude-test"])
async def test_template_prompt_order_uses_provider_role_mapping(
    monkeypatch: pytest.MonkeyPatch, provider_model: str,
) -> None:
    fixture = _WireCapture(
        (lambda _path, _payload: _openai_response())
        if provider_model.startswith("openai/")
        else (lambda _path, _payload: _anthropic_response())
    )
    await fixture.start()
    try:
        client = _openai_client(monkeypatch, f"{fixture.base_url}/v1")
        ordered = [
            SystemMessage(content="template-prefix"),
            HumanMessage(content="history-marker"),
            SystemMessage(content="selected-platform-instructions"),
            HumanMessage(content="current-prompt"),
        ]
        message_dicts, _params = client._create_message_dicts(ordered, None)
        response = await litellm.acompletion(
            model=provider_model,
            messages=message_dicts,
            api_base=f"{fixture.base_url}/v1" if provider_model.startswith("openai/") else fixture.base_url,
            api_key="sk-fake",
            max_tokens=256,
            stream=False,
            max_retries=0,
            timeout=10,
        )

        assert len(fixture.requests) == 1
        _path, body, _headers = fixture.requests[0]
        if provider_model.startswith("openai/"):
            assert [(message["role"], message["content"]) for message in body["messages"]] == [
                ("system", "template-prefix"),
                ("user", "history-marker"),
                ("system", "selected-platform-instructions"),
                ("user", "current-prompt"),
            ]
        else:
            # Anthropic transports system blocks in its top-level `system`
            # field, so cross-role interleaving cannot survive this provider's
            # protocol. Verify system-block order and user-content order rather
            # than claiming OpenAI-style cross-role order is preserved.
            system = body.get("system", "")
            if isinstance(system, list):
                system_text = "\n".join(str(block.get("text", "")) for block in system if isinstance(block, dict))
            else:
                system_text = str(system)
            assert system_text.index("template-prefix") < system_text.index("selected-platform-instructions")
            user_blocks = [
                block.get("text", "")
                for message in body["messages"] if message["role"] == "user"
                for block in (message["content"] if isinstance(message["content"], list) else [])
            ]
            assert user_blocks == ["history-marker", "current-prompt"]
        assert response.choices[0].message.content == "ok"
    finally:
        await fixture.stop()
