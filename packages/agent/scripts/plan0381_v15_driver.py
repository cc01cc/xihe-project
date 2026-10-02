"""Real cross-module PLAN-0381 V15 driver; services are provided externally."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx

from xihe_agent.adapters.mcp_client import MCPClientManager
from xihe_agent.agent_runner.langgraph_runner import LangGraphRunner
from xihe_agent.context.event_sourced_provider import EventSourcedContextProvider
from xihe_agent.context.store_client import CPContextServiceClient, CPEventStoreClient
from xihe_agent.interfaces.agent_runner import RunnerConfig
from xihe_agent.interfaces.message import TextMessage
from xihe_agent.llm.base import LLMConfig, XiheLiteLLM

MARKER = "PLAN0381_LARGE_MARKER"
TOOL_TIMEOUT = 180.0
PROVIDER_TIMEOUT = 30.0


class OpenAIWireFixture:
    """Small local OpenAI-compatible chat-completions server with captured requests."""

    def __init__(self, tool_name: str, call_id: str) -> None:
        self.tool_name = tool_name
        self.call_id = call_id
        self.requests: list[dict[str, Any]] = []
        self._server: asyncio.AbstractServer | None = None
        self.base_url = ""

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        host, port = self._server.sockets[0].getsockname()[:2]
        self.base_url = f"http://{host}:{port}/v1"

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), PROVIDER_TIMEOUT)
            headers = {
                line.split(":", 1)[0].strip().lower(): line.split(":", 1)[1].strip()
                for line in head.decode("latin-1").split("\r\n")[1:]
                if ":" in line
            }
            length = int(headers.get("content-length", "0"))
            raw = await asyncio.wait_for(reader.readexactly(length), PROVIDER_TIMEOUT)
            payload = json.loads(raw)
            self.requests.append(payload)
            index = len(self.requests)
            if index == 1:
                message: dict[str, Any] = {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": self.call_id,
                            "type": "function",
                            "function": {
                                "name": self.tool_name,
                                "arguments": json.dumps({"path": "large.txt"}),
                            },
                        }
                    ],
                }
                finish_reason = "tool_calls"
            else:
                message = {"role": "assistant", "content": f"fixture-final-{index}"}
                finish_reason = "stop"
            delta: dict[str, Any] = {"role": "assistant"}
            if message.get("content") is not None:
                delta["content"] = message["content"]
            if message.get("tool_calls"):
                delta["tool_calls"] = [{"index": 0, **message["tool_calls"][0]}]
            chunks = [
                {
                    "id": f"chatcmpl-plan0381-{index}",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": "plan0381-fixture",
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
                },
                {
                    "id": f"chatcmpl-plan0381-{index}",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": "plan0381-fixture",
                    "choices": [],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                },
            ]
            body = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
            encoded_body = body.encode()
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                + f"Content-Length: {len(encoded_body)}\r\nConnection: close\r\n\r\n".encode("latin-1")
                + encoded_body
            )
            await writer.drain()
        except Exception:
            traceback.print_exc(file=sys.stderr)
        finally:
            writer.close()
            await writer.wait_closed()


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"Required environment variable {name} is missing")
    return value


async def _runtime_seed(runtime_url: str, service_token: str, workspace_id: str) -> None:
    headers = {"Authorization": f"Bearer {service_token}"}
    timeout = httpx.Timeout(30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        content = f"{MARKER}\n" + ("bounded-evidence-content-" * 700)
        if len(content) < 12_000:
            raise AssertionError("seed content must contain at least 12000 characters")
        # This first file operation deliberately triggers Runtime hydrate from
        # CP's execution-spec; do not direct-create the Runtime workspace (that
        # would bypass the very cross-service boundary V15 audits).
        write = await client.post(
            f"{runtime_url.rstrip('/')}/internal/v1/runtime/workspaces/{workspace_id}/files/write/large.txt",
            headers=headers,
            content=content.encode(),
        )
        write.raise_for_status()


def _event_counts(events: list[Any], call_id: str) -> dict[str, int]:
    return {
        kind: sum(
            event.type == kind
            and str(event.payload.get("toolCallId", event.payload.get("call_id", ""))) == call_id
            for event in events
        )
        for kind in ("tool.called", "tool.result")
    }


async def _consume(runner: LangGraphRunner, config: RunnerConfig, prompt: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []

    async def collect() -> None:
        async for event in runner.stream([TextMessage(role="human", content=prompt)], config):
            result.append({"type": event.type, "data": event.data})

    await asyncio.wait_for(collect(), timeout=TOOL_TIMEOUT + PROVIDER_TIMEOUT * 3)
    return result


async def run() -> dict[str, Any]:
    os.environ["XIHE_CONTEXT_EVENT_WRITER_V2"] = "1"
    cp_url = _required_env("XIHE_CP_URL").rstrip("/")
    runtime_url = _required_env("XIHE_RUNTIME_URL").rstrip("/")
    user_token = _required_env("XIHE_USER_TOKEN")
    service_token = _required_env("XIHE_SERVICE_TOKEN")
    workspace_id = _required_env("XIHE_WORKSPACE_ID")
    session_id = _required_env("XIHE_SESSION_ID")
    _required_env("XIHE_EVIDENCE_PATH")

    event_store = CPEventStoreClient(cp_url, service_token)
    context_client = CPContextServiceClient(cp_url, service_token)
    manager = MCPClientManager(
        cp_url=f"{cp_url}/api/v1/mcp",
        workspace_id=workspace_id,
        api_token=user_token,
        max_retries=0,
    )
    provider: OpenAIWireFixture | None = None
    passed: list[str] = []
    evidence: dict[str, Any] = {
        "cpUrl": cp_url,
        "runtimeUrl": runtime_url,
        "workspaceId": workspace_id,
        "sessionId": session_id,
        "pass": False,
        "assertions": passed,
    }
    try:
        await _runtime_seed(runtime_url, service_token, workspace_id)
        passed.append("runtime_file_fixture_written_via_cp_execution_spec_hydrate")
        # User-principal MCP discovery/calls require both bearer auth and the
        # same workspace/session binding; grant failures intentionally fail here.
        await manager.initialize()
        candidates = [tool for tool in manager.tools if tool.spec.name in {"read_file", "runtime__read_file"}]
        if not candidates:
            candidates = [tool for tool in manager.tools if "read" in tool.spec.name.lower() and "file" in tool.spec.name.lower()]
        if not candidates:
            raise RuntimeError("CP MCP discovery exposed no file-read tool; refusing direct/fallback execution")
        tool = candidates[0]
        provider_call_id = f"call-plan0381-{uuid4().hex}"
        provider = OpenAIWireFixture(tool.spec.name, provider_call_id)
        await provider.start()

        context = await EventSourcedContextProvider(context_client).load(session_id)
        context.metadata["sessionId"] = session_id
        context.metadata["workspaceId"] = workspace_id
        evidence["initialSnapshotSequence"] = context.latest_sequence
        passed.append("initial_context_loaded_from_cp_projection")

        llm_config = LLMConfig(
            provider="openai",
            route_provider="openai",
            api_key="plan0381-local-fixture",
            api_base=provider.base_url,
            model="plan0381-fixture",
            timeout=PROVIDER_TIMEOUT,
            max_tokens=512,
            temperature=0,
        )
        runner = LangGraphRunner(
            model_factory=lambda _model: XiheLiteLLM(config=llm_config),
            event_store=event_store,
        )
        first_config = RunnerConfig(
            model="openai/plan0381-fixture",
            system_prompt="Use the available file reader when asked.",
            tools=[tool],
            max_turns=3,
            context=context,
        )
        first_events = await _consume(runner, first_config, "Read large.txt and summarize its marker.")
        if len(provider.requests) != 2:
            raise AssertionError(f"first run expected tool-call and final provider requests, got {len(provider.requests)}")
        declared_names = {
            item.get("function", {}).get("name") for item in provider.requests[0].get("tools", [])
        }
        if tool.spec.name not in declared_names:
            raise AssertionError("first provider wire request did not declare the discovered MCP tool")
        events_before = [event async for event in event_store.read(session_id)]
        tool_call_events = [event for event in events_before if event.type == "tool.called"]
        if len(tool_call_events) != 1:
            raise AssertionError(f"expected one durable tool.called event, got {len(tool_call_events)}")
        call_id = str(tool_call_events[0].payload.get("toolCallId", tool_call_events[0].payload.get("call_id", "")))
        if not call_id:
            raise AssertionError("durable tool.called event has no call id")
        if tool_call_events[0].aggregate_id != session_id:
            raise AssertionError("Runner wrote tool.called to an aggregate other than XIHE_SESSION_ID")
        declaration = tool_call_events[0].payload
        durable_name = declaration.get("toolName", declaration.get("tool_name"))
        durable_arguments = declaration.get("arguments", declaration.get("tool_input", {}))
        if durable_name != tool.spec.name or durable_arguments != {"path": "large.txt"}:
            raise AssertionError(
                f"Runner durable call differs from discovered tool invocation: name={durable_name!r}, args={durable_arguments!r}"
            )
        counts_before = _event_counts(events_before, call_id)

        cp_snapshot = await context_client.get_context_snapshot(session_id)
        restored = await EventSourcedContextProvider(context_client).load(session_id)
        restored.metadata["sessionId"] = session_id
        restored.metadata["workspaceId"] = workspace_id
        pair = next((message for message in restored.messages if any(ref.call_id == call_id for ref in message.tool_calls)), None)
        result_message = next((message for message in restored.messages if message.role == "tool" and message.tool_call_id == call_id), None)
        if pair is None or result_message is None:
            raise AssertionError("CP projection did not restore a paired assistant tool-call/result")
        if pair.tool_calls[0].tool_name != tool.spec.name or pair.tool_calls[0].arguments != {"path": "large.txt"}:
            raise AssertionError("CP projection changed the assistant tool-call name or arguments")
        if MARKER not in result_message.content:
            raise AssertionError("bounded restored tool preview omitted fixture marker")
        if not result_message.truncated:
            raise AssertionError("large file tool result was not marked truncated")
        if len(result_message.content) >= 12_000:
            raise AssertionError("CP snapshot retained the full large file result")
        passed.extend(["cp_tool_call_result_paired", "preview_bounded_marker_and_truncation"])

        second_config = RunnerConfig(
            model="openai/plan0381-fixture",
            system_prompt="Continue using restored session history.",
            tools=[tool],
            max_turns=2,
            context=restored,
        )
        second_runner = LangGraphRunner(
            model_factory=lambda _model: XiheLiteLLM(config=llm_config),
            event_store=event_store,
        )
        second_events = await _consume(
            second_runner, second_config, "Continue from the previous result; do not reread the file."
        )
        if len(provider.requests) != 3:
            raise AssertionError(f"second run expected one final provider request, got {len(provider.requests) - 2}")
        wire_messages = provider.requests[2].get("messages", [])
        assistant = next((item for item in wire_messages if item.get("role") == "assistant" and item.get("tool_calls")), None)
        wire_call = assistant["tool_calls"][0] if assistant else None
        wire_result = next((item for item in wire_messages if item.get("role") == "tool" and item.get("tool_call_id") == call_id), None)
        if not wire_call or wire_call.get("id") != call_id or wire_call.get("function", {}).get("name") != tool.spec.name:
            raise AssertionError("actual second-round provider request lacks the paired assistant tool-call")
        if json.loads(wire_call["function"]["arguments"]) != {"path": "large.txt"}:
            raise AssertionError("provider wire changed tool-call arguments")
        if wire_result is None or MARKER not in str(wire_result.get("content", "")):
            raise AssertionError("actual second-round provider request lacks the paired bounded tool result")
        events_after = [event async for event in event_store.read(session_id)]
        counts_after = _event_counts(events_after, call_id)
        if counts_before != {"tool.called": 1, "tool.result": 1} or counts_after != counts_before:
            raise AssertionError(f"tool event count mismatch or re-execution: before={counts_before}, after={counts_after}")
        passed.extend(["second_provider_wire_contains_restored_pair", "second_round_did_not_reexecute_tool"])
        evidence.update(
            {
                "toolName": tool.spec.name,
                "toolCallId": call_id,
                "providerToolCallId": provider_call_id,
                "previewLength": len(result_message.content),
                "previewContainsMarker": MARKER in result_message.content,
                "previewTruncated": result_message.truncated,
                "cpSnapshotSequence": cp_snapshot.get("latest_sequence", cp_snapshot.get("latestSequence")),
                "firstRunEvents": first_events,
                "secondRunEvents": second_events,
                "firstProviderRequestSummary": {
                    "count": len(provider.requests[:2]),
                    "firstRequestToolDeclarations": len(provider.requests[0].get("tools", [])),
                    "secondRequestHasToolResult": any(message.get("role") == "tool" for message in provider.requests[1].get("messages", [])),
                },
                "secondProviderRequestSummary": {
                    "count": 1,
                    "restoredToolCallId": wire_call["id"],
                    "restoredToolName": wire_call["function"]["name"],
                    "toolResultLength": len(str(wire_result.get("content", ""))),
                },
                "eventCountsBeforeSecondRound": counts_before,
                "eventCountsAfterSecondRound": counts_after,
                "assertions": passed,
                "pass": True,
            }
        )
        return evidence
    finally:
        close_manager = getattr(manager, "close", None)
        if close_manager is not None:
            await close_manager()
        if provider is not None:
            await provider.close()
        await event_store._client.aclose()
        await context_client._client.aclose()


async def main() -> int:
    evidence_path = os.environ.get("XIHE_EVIDENCE_PATH", "")
    try:
        result = await run()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if evidence_path:
            Path(evidence_path).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return 0
    except Exception as error:
        result = {
            "cpUrl": os.environ.get("XIHE_CP_URL"),
            "runtimeUrl": os.environ.get("XIHE_RUNTIME_URL"),
            "workspaceId": os.environ.get("XIHE_WORKSPACE_ID"),
            "sessionId": os.environ.get("XIHE_SESSION_ID"),
            "assertions": [],
            "pass": False,
            "error": str(error),
            "traceback": traceback.format_exc(),
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if evidence_path:
            Path(evidence_path).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
