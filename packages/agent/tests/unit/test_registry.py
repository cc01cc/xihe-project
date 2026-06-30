import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

from langchain_core.tools import BaseTool, tool

from xihe_agent.registry import WorkerConfig
from xihe_agent.registry.registry import (
    WorkerRegistry,
    _build_worker_graph,
    _get_tools_for_worker,
)


@tool
def mock_tool_a() -> str:
    """Mock tool A."""
    return "a"


@tool
def mock_tool_b() -> str:
    """Mock tool B."""
    return "b"


class FakeCustomTool(BaseTool):
    name: str = "custom_tool"
    description: str = "A custom tool"

    def _run(self, **kwargs):
        return "custom"

    async def _arun(self, **kwargs):
        return "custom"


def test_get_tools_for_worker_no_filter():
    config = WorkerConfig(id="t", name="t", description="t", tool_keys=[])
    mcp = [mock_tool_a, mock_tool_b]
    custom = [FakeCustomTool()]
    result = _get_tools_for_worker(config, mcp, custom)
    assert len(result) == 3
    assert mock_tool_a in result
    assert mock_tool_b in result
    assert any(t.name == "custom_tool" for t in result)


def test_get_tools_for_worker_with_filter():
    config = WorkerConfig(id="t", name="t", description="t", tool_keys=["mock_tool_a"])
    mcp = [mock_tool_a, mock_tool_b]
    custom = [FakeCustomTool()]
    result = _get_tools_for_worker(config, mcp, custom)
    names = [t.name for t in result]
    assert "mock_tool_a" in names
    assert "mock_tool_b" not in names
    assert "custom_tool" in names


def test_get_tools_for_worker_no_mcp_match():
    config = WorkerConfig(id="t", name="t", description="t", tool_keys=["nonexistent"])
    mcp = [mock_tool_a]
    custom = [FakeCustomTool()]
    result = _get_tools_for_worker(config, mcp, custom)
    names = [t.name for t in result]
    assert "mock_tool_a" not in names
    assert "custom_tool" in names


def test_build_worker_graph_success():
    model = MagicMock()
    config = WorkerConfig(id="g", name="g", description="g", system_prompt="You are G.")
    graph = _build_worker_graph(config, model, [mock_tool_a], [])
    assert graph is not None


def test_build_worker_graph_failure():
    model = MagicMock()

    class BrokenTool(BaseTool):
        name: str = "broken"
        description: str = ""

        def _run(self, **kwargs):
            return ""

    with patch("xihe_agent.registry.registry.create_react_agent", side_effect=ValueError("boom")):
        config = WorkerConfig(id="b", name="b", description="b")
        graph = _build_worker_graph(config, model, [BrokenTool()], [])
        assert graph is None


def test_registry_list_empty():
    reg = WorkerRegistry(workers_dir="/tmp/nonexistent")
    assert reg.list_workers() == []


def test_registry_register_and_list():
    reg = WorkerRegistry(workers_dir="/tmp/nonexistent")
    config = WorkerConfig(id="w1", name="W1", description="Worker 1", enabled=True)
    model = MagicMock()
    reg.register(config, model, [], [])
    workers = reg.list_workers()
    assert len(workers) == 1
    assert workers[0].id == "w1"
    assert workers[0].enabled is True


def test_registry_list_enabled():
    reg = WorkerRegistry(workers_dir="/tmp/nonexistent")
    model = MagicMock()
    reg.register(WorkerConfig(id="e1", name="E1", description="", enabled=True), model, [], [])
    reg.register(WorkerConfig(id="d1", name="D1", description="", enabled=False), model, [], [])
    enabled = reg.list_enabled()
    assert len(enabled) == 1
    assert enabled[0].id == "e1"


def test_registry_get_worker():
    reg = WorkerRegistry(workers_dir="/tmp/nonexistent")
    model = MagicMock()
    config = WorkerConfig(id="g1", name="G1", description="", enabled=True)
    reg.register(config, model, [], [])
    graph = reg.get_worker("g1")
    assert graph is not None


def test_registry_get_worker_disabled():
    reg = WorkerRegistry(workers_dir="/tmp/nonexistent")
    model = MagicMock()
    config = WorkerConfig(id="g2", name="G2", description="", enabled=False)
    reg.register(config, model, [], [])
    graph = reg.get_worker("g2")
    assert graph is None


def test_registry_get_worker_unknown():
    reg = WorkerRegistry(workers_dir="/tmp/nonexistent")
    assert reg.get_worker("unknown") is None


def test_registry_enable_disable():
    reg = WorkerRegistry(workers_dir="/tmp/nonexistent")
    model = MagicMock()
    config = WorkerConfig(id="t", name="T", description="", enabled=False, file_path="")
    reg.register(config, model, [], [])

    assert reg.get_worker("t") is None
    ok = reg.enable("t", model, [], [])
    assert ok is True
    assert reg.get_worker("t") is not None

    ok = reg.disable("t")
    assert ok is True
    assert reg.get_worker("t") is None


def test_registry_enable_unknown():
    reg = WorkerRegistry(workers_dir="/tmp/nonexistent")
    assert reg.enable("unknown", MagicMock(), [], []) is False


def test_registry_disable_unknown():
    reg = WorkerRegistry(workers_dir="/tmp/nonexistent")
    assert reg.disable("unknown") is False


def test_registry_unregister():
    reg = WorkerRegistry(workers_dir="/tmp/nonexistent")
    model = MagicMock()
    reg.register(WorkerConfig(id="u1", name="U1", description=""), model, [], [])
    assert len(reg.list_workers()) == 1
    reg.unregister("u1")
    assert len(reg.list_workers()) == 0


def test_registry_unregister_unknown():
    reg = WorkerRegistry(workers_dir="/tmp/nonexistent")
    assert reg.unregister("unknown") is False


def test_registry_reload():
    with tempfile.TemporaryDirectory() as tmp:
        md_path = Path(tmp) / "r.md"
        md_path.write_text("""\
---
id: r
name: R
---

Original
""")
        reg = WorkerRegistry(workers_dir=tmp)
        model = MagicMock()
        reg.register(
            WorkerConfig(id="r", name="R", description="", file_path=str(md_path)),
            model, [], [],
        )
        assert len(reg.list_workers()) == 1

        md_path.write_text("""\
---
id: r
name: R2
---

Updated
""")
        ok = reg.reload("r", model, [], [])
        assert ok is True
        worker = reg.list_workers()[0]
        assert worker.error is None


def test_registry_reload_unknown():
    reg = WorkerRegistry(workers_dir="/tmp/nonexistent")
    assert reg.reload("unknown", MagicMock(), [], []) is False


def test_registry_worker_status_error_on_failed_graph():
    reg = WorkerRegistry(workers_dir="/tmp/nonexistent")
    model = MagicMock()

    with patch("xihe_agent.registry.registry._build_worker_graph", return_value=None):
        config = WorkerConfig(id="f", name="F", description="")
        reg.register(config, model, [], [])
        statuses = reg.list_workers()
        assert len(statuses) == 1
        assert statuses[0].error is not None


def test_registry_workers_dir_property():
    reg = WorkerRegistry(workers_dir="/custom/path")
    assert reg.workers_dir == "/custom/path"


def test_registry_default_dir():
    with patch.dict(os.environ, {}, clear=True):
        reg = WorkerRegistry()
        assert reg.workers_dir == "./agents"


def test_registry_load_all():
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "a.md").write_text("""\
---
id: a
---

Worker A
""")
        (Path(tmp) / "b.md").write_text("""\
---
id: b
---

Worker B
""")
        reg = WorkerRegistry(workers_dir=tmp)
        model = MagicMock()
        reg.load_all(model, [], [])
        assert len(reg.list_workers()) == 2
