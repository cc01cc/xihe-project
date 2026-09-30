"""PLAN-0381 M2（T2.3/T2.4）：工具结果有界 preview 与事件形状。

契约：plans/PLAN-0381-XH-context-history-tool-output-bounds/evidence/m2-contract.md
§1.2 矩阵与 §3 边界；覆盖命令（结构化）、read_file/通用 MCP（文本）、gate
双形状与模型可见 body 的大小边界。超界必须显式截断，不静默丢失。
"""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

import xihe_agent.agent_runner.langgraph_runner as langgraph_runner_module
from xihe_agent.agent_runner.langgraph_runner import (
    EVENT_WRITER_V2_ENV,
    RESULT_PREVIEW_LIMIT,
    LCToolAdapter,
)
from xihe_agent.context.diagnostics import extract_command_result
from xihe_agent.interfaces.context import AgentContext
from xihe_agent.interfaces.tool import ToolSpec

STDOUT_FIELD = langgraph_runner_module.COMMAND_STDOUT_PREVIEW_CHARS
STDERR_FIELD = langgraph_runner_module.COMMAND_STDERR_PREVIEW_CHARS
bound_tool_preview = langgraph_runner_module.bound_tool_preview
build_tool_event_result = langgraph_runner_module.build_tool_event_result


def _cmd(
    stdout: str,
    stderr: str,
    exit_code: int,
    *,
    artifact_id: str | None = None,
    stdout_truncated: bool = False,
    stderr_truncated: bool = False,
    nested: bool = False,
) -> str:
    """Runtime CommandResult wire shape（serde：snake_case，缺省字段跳过）。"""
    payload: dict = {
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": exit_code,
        "success": exit_code == 0,
    }
    if artifact_id is not None:
        payload["artifact_id"] = artifact_id
    if stdout_truncated:
        payload["stdout_truncated"] = True
    if stderr_truncated:
        payload["stderr_truncated"] = True
    if nested:
        payload = {"result": payload}
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _bounds(content: str):
    return bound_tool_preview(content, extract_command_result(content))


# --- T2.4 命令类 ------------------------------------------------------------


def test_small_command_result_passes_through_byte_identical():
    content = _cmd("out", "err", 1)
    preview, meta = _bounds(content)
    assert preview == content
    assert meta == {"truncated": False, "sizeBytes": len(content.encode("utf-8"))}


def test_overflow_command_keeps_metadata_and_bounds_streams():
    content = _cmd(
        "x" * 9000,
        "err-tail",
        2,
        artifact_id="art-42",
        stdout_truncated=True,
    )
    preview, meta = _bounds(content)

    assert len(preview) <= RESULT_PREVIEW_LIMIT
    tree = json.loads(preview)
    assert tree["exit_code"] == 2
    assert tree["artifact_id"] == "art-42"
    assert tree["stdout"].startswith("x" * 200)
    assert "[truncated: first" in tree["stdout"]
    assert len(json.dumps(tree["stdout"], ensure_ascii=False)) <= STDOUT_FIELD
    assert tree["stderr"] == "err-tail"
    # §1.2 行 2：wire 截断 + bundle 成功 → available；完整大小未知 → 无 sizeBytes。
    assert meta == {"truncated": True, "artifactRef": "art-42", "status": "available"}


def test_stderr_overflow_is_bounded_to_the_same_threshold_class():
    content = _cmd(
        "fine",
        "e" * 6000,
        0,
        artifact_id="art-9",
        stderr_truncated=True,
    )
    preview, meta = _bounds(content)

    tree = json.loads(preview)
    assert tree["stdout"] == "fine"
    assert "[truncated: first" in tree["stderr"]
    assert len(json.dumps(tree["stderr"], ensure_ascii=False)) <= STDERR_FIELD
    assert meta["status"] == "available"
    assert meta["artifactRef"] == "art-9"


def test_wire_truncated_without_ref_reports_artifact_unavailable():
    # §1.2 行 3：wire 截断但 bundle 没落成（预算满/IO 失败/旧 runtime）。
    content = _cmd("y" * 5000, "", 1, stdout_truncated=True)
    preview, meta = _bounds(content)

    assert len(preview) <= RESULT_PREVIEW_LIMIT
    assert meta == {
        "truncated": True,
        "status": "unavailable",
        "errorCode": "artifact_unavailable",
    }


def test_uniform_preview_cut_keeps_known_size_and_no_error_code():
    # §1.2 行 4：wire 未截断，仅统一 4096 预览界 → 完整字节数已知、无错误码。
    content = _cmd("z" * 3500, "", 0)
    preview, meta = _bounds(content)

    tree = json.loads(preview)
    assert "[truncated: first" in tree["stdout"]
    assert meta == {
        "truncated": True,
        "status": "unavailable",
        "sizeBytes": len(content.encode("utf-8")),
    }


def test_worst_case_command_preview_fits_the_frozen_limit():
    content = _cmd(
        "A" * 100_000,
        "B" * 50_000,
        1,
        artifact_id="art-" + "1" * 36,
        stdout_truncated=True,
        stderr_truncated=True,
    )
    preview, meta = _bounds(content)

    assert len(preview) <= RESULT_PREVIEW_LIMIT
    tree = json.loads(preview)  # 病态兜底前必须仍是合法 JSON
    assert tree["exit_code"] == 1
    assert meta["artifactRef"].startswith("art-")


def test_escape_heavy_stdout_stays_within_field_budget():
    # 转义可放大 6×：字段预算按序列化长度判据（_fit 迭代）。
    content = _cmd('"' * 9000, "", 0, artifact_id="a1", stdout_truncated=True)
    preview, _ = _bounds(content)

    tree = json.loads(preview)
    assert len(json.dumps(tree["stdout"], ensure_ascii=False)) <= STDOUT_FIELD


def test_nested_command_payload_is_bounded_in_place():
    content = _cmd("n" * 9000, "", 0, artifact_id="art-n", stdout_truncated=True, nested=True)
    preview, meta = _bounds(content)

    assert len(preview) <= RESULT_PREVIEW_LIMIT
    outer = json.loads(preview)
    assert outer["result"]["exit_code"] == 0
    assert outer["result"]["artifact_id"] == "art-n"
    assert "[truncated: first" in outer["result"]["stdout"]
    assert meta["artifactRef"] == "art-n"


def test_bounded_preview_still_parses_for_diagnostics():
    content = _cmd("x" * 9000, "", 3, artifact_id="art-7", stdout_truncated=True)
    preview, _ = _bounds(content)

    parsed = extract_command_result(preview)
    assert parsed is not None, "preview must remain a locatable command payload"
    assert parsed[2] == 3, "exit_code must survive the bound"


# --- T2.4 非命令类（read_file / 通用 MCP，Frozen #3：无 ref）-----------------


def test_small_non_command_content_passes_through():
    content = "just a small result"
    preview, meta = bound_tool_preview(content, None)
    assert preview == content
    assert meta == {"truncated": False, "sizeBytes": len(content.encode("utf-8"))}


def test_large_non_command_content_gets_explicit_marker_and_no_ref():
    content = "file-body " * 5000
    preview, meta = bound_tool_preview(content, None)

    assert len(preview) <= RESULT_PREVIEW_LIMIT
    assert preview.startswith("file-body ")
    assert "[output truncated: first" in preview
    assert "no retained copy" in preview
    # Frozen #3：不声称存在可读取的完整结果 → 无 artifactRef。
    assert meta == {
        "truncated": True,
        "sizeBytes": len(content.encode("utf-8")),
        "status": "unavailable",
    }
    assert "artifactRef" not in meta


def test_non_command_marker_starts_inside_budget():
    # 标记本身计入 4096 预算：shown + len(marker) 精确对齐。
    content = "a" * (RESULT_PREVIEW_LIMIT * 3)
    preview, _ = bound_tool_preview(content, None)
    assert len(preview) <= RESULT_PREVIEW_LIMIT
    shown_part, marker = preview.split("\n[output truncated:", 1)
    assert len(shown_part) + len("\n[output truncated:" + marker) == len(preview)


# --- gate 双形状（T2.3 / m2-contract §3）-----------------------------------


def test_gate_off_emits_bounded_preview_string(monkeypatch):
    monkeypatch.delenv(EVENT_WRITER_V2_ENV, raising=False)
    meta = {"truncated": True, "status": "unavailable"}
    assert build_tool_event_result("bounded…", meta) == "bounded…"


def test_gate_on_emits_preview_object_with_whitelisted_meta(monkeypatch):
    monkeypatch.setenv(EVENT_WRITER_V2_ENV, "1")
    meta = {
        "truncated": True,
        "artifactRef": "art-1",
        "sizeBytes": None,  # None 不输出
        "status": "available",
        "errorCode": None,
    }
    assert build_tool_event_result("bounded…", meta) == {
        "preview": "bounded…",
        "truncated": True,
        "artifactRef": "art-1",
        "status": "available",
    }


def test_gate_on_full_matrix_row_two(monkeypatch):
    monkeypatch.setenv(EVENT_WRITER_V2_ENV, "1")
    preview, meta = _bounds(
        _cmd("q" * 9000, "", 0, artifact_id="art-m", stdout_truncated=True)
    )
    result = build_tool_event_result(preview, meta)
    assert result["truncated"] is True
    assert result["artifactRef"] == "art-m"
    assert result["status"] == "available"
    assert "sizeBytes" not in result
    assert len(result["preview"]) <= RESULT_PREVIEW_LIMIT


# --- _arun 端到端：事件 + 模型 body ----------------------------------------


class _CannedTool:
    def __init__(self, payload: str, name: str = "execute_command"):
        self._spec = ToolSpec(
            name=name,
            description="Execute a shell command",
            input_schema={"type": "object", "properties": {"command": {"type": "string"}}},
        )
        self._payload = payload

    @property
    def spec(self) -> ToolSpec:
        return self._spec

    async def execute(self, input: dict, context) -> dict:
        return {"content": self._payload}


@pytest.mark.asyncio
async def test_arun_event_and_model_body_only_carry_bounded_preview(monkeypatch):
    monkeypatch.setenv(EVENT_WRITER_V2_ENV, "1")
    event_store = MagicMock()
    event_store.append = AsyncMock()
    content = _cmd("x" * 9000, "warn-line", 0, artifact_id="art-9", stdout_truncated=True)
    adapter = LCToolAdapter(_CannedTool(content), AgentContext.empty("s-bounds"), event_store)

    text, artifact = await adapter._arun(command="build")

    # 事件：result 对象化且只携带有界 preview（不落完整大输出）。
    events = [call.args[0] for call in event_store.append.await_args_list]
    result_event = next(event for event in events if event.type == "tool.result")
    result = result_event.payload["result"]
    assert isinstance(result, dict)
    assert len(result["preview"]) <= RESULT_PREVIEW_LIMIT
    assert result["artifactRef"] == "art-9"
    assert result["status"] == "available"
    assert "x" * 5000 not in json.dumps(result)

    # 模型 body：预览有界 + 关键元数据（exit/artifact 引用）仍可见。
    assert "x" * 5000 not in text
    assert "[truncated: first" in text
    assert "exit_code" in text
    assert "art-9" in text  # 恢复路径：模型可据此调用 read_command_output
    assert artifact is None  # exit 0 → 无诊断 bundle


@pytest.mark.asyncio
async def test_arun_legacy_gate_writes_bounded_string_result(monkeypatch):
    monkeypatch.delenv(EVENT_WRITER_V2_ENV, raising=False)
    event_store = MagicMock()
    event_store.append = AsyncMock()
    content = _cmd("x" * 9000, "", 0, artifact_id="art-legacy", stdout_truncated=True)
    adapter = LCToolAdapter(_CannedTool(content), AgentContext.empty("s-legacy"), event_store)

    await adapter._arun(command="build")

    events = [call.args[0] for call in event_store.append.await_args_list]
    result_event = next(event for event in events if event.type == "tool.result")
    stored = result_event.payload["result"]
    assert isinstance(stored, str), "gate OFF 必须保持 legacy 字符串形状"
    assert len(stored) <= RESULT_PREVIEW_LIMIT
    assert "art-legacy" in stored
    assert "x" * 5000 not in stored


def test_gate_on_result_object_round_trips_through_reader(monkeypatch):
    """M2 写出的对象形状必须被 M1 reader-first 解析（双向不漂移）。"""
    from xihe_agent.interfaces.context import parse_tool_result

    monkeypatch.setenv(EVENT_WRITER_V2_ENV, "1")
    preview, meta = _bounds(
        _cmd("x" * 9000, "", 0, artifact_id="art-rt", stdout_truncated=True)
    )
    stored = build_tool_event_result(preview, meta)

    parsed = parse_tool_result(stored)
    assert parsed.content == preview
    assert parsed.truncated is True
    assert parsed.artifact_ref == "art-rt"
    assert parsed.error_code == ""
    assert parsed.legacy_normalized is False


def test_gate_off_result_string_round_trips_through_reader(monkeypatch):
    from xihe_agent.interfaces.context import parse_tool_result

    monkeypatch.delenv(EVENT_WRITER_V2_ENV, raising=False)
    preview, meta = _bounds(_cmd("x" * 9000, "", 0, stdout_truncated=True))
    stored = build_tool_event_result(preview, meta)

    assert isinstance(stored, str)
    parsed = parse_tool_result(stored)
    assert parsed.content == stored  # legacy 字符串 → preview（契约 §3 规则 2）
    assert parsed.truncated is False  # legacy 形状的既定降级：标记在文本内


# --- review 回归（P0-2 / P1-1 / P1-2 / P1-3）------------------------------


def test_command_shape_with_oversized_sibling_key_is_bounded():
    """Review P0-2：exit_code 可 locate 但 stdout/stderr 未超阈值时，
    其他大键撑爆的整体仍必须过统一 4096 界（read_file 读到含 exit_code
    的 JSON 即命中该形状）。"""
    content = json.dumps(
        {"result": {"exit_code": 3, "payload": "A" * 50_000}},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    preview, meta = _bounds(content)

    assert len(preview) <= RESULT_PREVIEW_LIMIT
    assert "[output truncated: first" in preview
    assert meta == {
        "truncated": True,
        "sizeBytes": len(content.encode("utf-8")),
        "status": "unavailable",
    }


def test_argument_markers_survive_escape_inflation():
    """Review P1-1：标记对象自身序列化后必须 ≤ ARG_LIMIT（反斜杠 ×2、
    控制字符 ×6 的二次转义放大），Python/CPP 同规则。"""
    from xihe_agent.interfaces.context import (
        ARG_LIMIT,
        bound_tool_arguments,
        compact_json,
    )

    backslash_dict = {"path": "\\" * 6000}
    marker = bound_tool_arguments(backslash_dict)
    assert marker["__xihe_truncated__"] is True
    assert len(compact_json(marker)) <= ARG_LIMIT

    control_str = "\x00\x1f" * 3000
    raw_marker = bound_tool_arguments(control_str)
    assert raw_marker["__xihe_truncated__"] is True
    assert len(compact_json(raw_marker)) <= ARG_LIMIT

    # 普通超限仍按 M1 形状出标记（收缩只在转义膨胀时介入）。
    plain = bound_tool_arguments({"content": "x" * 5196})
    assert plain["__xihe_truncated__"] is True
    assert len(compact_json(plain)) <= ARG_LIMIT


def test_argument_marker_splits_on_code_points_only():
    """Review P1-3：码点切片不得产生孤立代理；astral 字符整入整出。"""
    import json as _json

    from xihe_agent.interfaces.context import ARG_LIMIT, bound_tool_arguments, compact_json

    marker = bound_tool_arguments({"text": "\U0001f600" * 5000})
    assert marker["__xihe_truncated__"] is True
    serialized = compact_json(marker)
    assert len(serialized) <= ARG_LIMIT
    parsed = _json.loads(serialized)
    prefix = parsed["__prefix__"]
    assert prefix, "prefix must not be empty after the bound"
    # 码点切片：astral 字符是单一 Python 字符，切点落点必为完整码点。
    assert ord(prefix[-1]) > 0xFFFF or prefix[-1].isprintable()
    assert ord(prefix[-1]) < 0xD800 or ord(prefix[-1]) > 0xDFFF


def test_mapping_bounds_replayed_tool_content():
    """Review P1-2 / Frozen #1 历史回放条款：回放进模型前统一 4096 界。"""
    from xihe_agent.interfaces.message import TextMessage, ToolCallRef

    history = [
        TextMessage(
            role="ai",
            content="",
            tool_calls=(ToolCallRef(call_id="c1", tool_name="t", arguments={}),),
        ),
        TextMessage(role="tool", content="R" * 6000, tool_call_id="c1"),
    ]
    mapped = langgraph_runner_module.to_langchain_messages(history)

    content = mapped[1].content
    assert len(content) <= RESULT_PREVIEW_LIMIT
    assert "[output truncated: first" in content

    # 孤儿结果（§7.4 降级事实）：先组装标签再整体加界，总长仍 ≤4096。
    orphan = langgraph_runner_module.to_langchain_messages(
        [TextMessage(role="tool", content="Q" * 6000, tool_call_id="gone")]
    )
    assert len(orphan[0].content) <= RESULT_PREVIEW_LIMIT
    assert orphan[0].content.startswith("[unpaired tool result: unknown]")
