"""Integration tests for Agent Worker Registry.

Tests the integration between:
- WorkerRegistry + file system (load/reload from .md files)
- WorkerRegistry + supervisor (build_supervisor_from_registry)
- Empty registry fallback
- Enable/disable lifecycle
"""

import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from langchain_core.tools import BaseTool, tool

from xihe_agent.agent.supervisor import build_supervisor
from xihe_agent.registry.registry import WorkerRegistry


@tool
def mock_web_fetch(url: str) -> str:
    """Fetch a web page."""
    return f"content from {url}"


@tool
def mock_edit_file(path: str, content: str) -> str:
    """Edit a file."""
    return f"edited {path}"


class FakeCustomTool(BaseTool):
    name: str = "generate_image"
    description: str = "Generate an image"

    def _run(self, **kwargs):
        return "image"

    async def _arun(self, **kwargs):
        return "image"


def _write_md(path: Path, content: str):
    path.write_text(content, encoding="utf-8")


class TestRegistrySupervisorIntegration:
    """Registry + supervisor integration: M3.#3.5."""

    @pytest.fixture(autouse=True)
    def _setup(self):
        self.model = MagicMock()
        self.model.agenerate = MagicMock()
        self.mcp_tools = [mock_web_fetch, mock_edit_file]
        self.custom_tools = [FakeCustomTool()]

    def test_registry_load_and_build_supervisor(self):
        """创建 markdown 文件 → load_all → build_supervisor_from_registry 成功."""
        with tempfile.TemporaryDirectory() as tmp:
            _write_md(Path(tmp) / "research.md", """\
---
id: research
name: 研究助手
description: 网页搜索
tool_keys:
  - mock_web_fetch
---

You are a research assistant.
""")
            _write_md(Path(tmp) / "code.md", """\
---
id: code
name: 代码助手
description: 代码编辑
tool_keys:
  - mock_edit_file
---

You are a code specialist.
""")
            reg = WorkerRegistry(workers_dir=tmp)
            reg.load_all(self.model, self.mcp_tools, self.custom_tools)

            workers = reg.list_workers()
            assert len(workers) == 2
            assert {w.id for w in workers} == {"research", "code"}

            graph = build_supervisor(self.model, self.mcp_tools, self.custom_tools, registry=reg)
            assert graph is not None

    def test_registry_empty_fallback(self):
        """registry 无 enabled worker → fallback 到 built-in build_supervisor_graph."""
        with tempfile.TemporaryDirectory() as tmp:
            reg = WorkerRegistry(workers_dir=tmp)
            reg.load_all(self.model, self.mcp_tools, self.custom_tools)

            assert len(reg.list_workers()) == 0
            assert len(reg.list_enabled()) == 0

            graph = build_supervisor(self.model, self.mcp_tools, self.custom_tools, registry=reg)
            assert graph is not None

    def test_registry_all_disabled_fallback(self):
        """所有 worker 被禁用 → fallback."""
        with tempfile.TemporaryDirectory() as tmp:
            _write_md(Path(tmp) / "a.md", """\
---
id: a
enabled: false
description: disabled
---

You are A.
""")
            reg = WorkerRegistry(workers_dir=tmp)
            reg.load_all(self.model, self.mcp_tools, self.custom_tools)

            enabled = reg.list_enabled()
            assert len(enabled) == 0

            graph = build_supervisor(self.model, self.mcp_tools, self.custom_tools, registry=reg)
            assert graph is not None

    def test_enable_disable_lifecycle(self):
        """enable/disable 影响 list_enabled 和 get_worker."""
        with tempfile.TemporaryDirectory() as tmp:
            _write_md(Path(tmp) / "w.md", """\
---
id: w
enabled: false
description: test
---

Worker W
""")
            reg = WorkerRegistry(workers_dir=tmp)
            reg.load_all(self.model, self.mcp_tools, self.custom_tools)

            assert len(reg.list_enabled()) == 0
            assert reg.get_worker("w") is None

            reg.enable("w", self.model, self.mcp_tools, self.custom_tools)
            assert len(reg.list_enabled()) == 1
            assert reg.get_worker("w") is not None

            reg.disable("w")
            assert len(reg.list_enabled()) == 0
            assert reg.get_worker("w") is None

    def test_file_change_and_reload(self):
        """修改 .md 文件 → reload → prompt 更新."""
        with tempfile.TemporaryDirectory() as tmp:
            md = Path(tmp) / "r.md"
            _write_md(md, """\
---
id: r
description: original
---

Original prompt
""")
            reg = WorkerRegistry(workers_dir=tmp)
            reg.load_all(self.model, self.mcp_tools, self.custom_tools)
            assert len(reg.list_workers()) == 1

            _write_md(md, """\
---
id: r
description: updated
---

Updated prompt
""")
            ok = reg.reload("r", self.model, self.mcp_tools, self.custom_tools)
            assert ok is True
            status = reg.list_workers()[0]
            assert status.error is None

    def test_file_delete_and_unregister(self):
        """删除 .md 文件 → unregister → registry 中移除."""
        with tempfile.TemporaryDirectory() as tmp:
            md = Path(tmp) / "d.md"
            _write_md(md, """\
---
id: d
description: to-delete
---

Delete me
""")
            reg = WorkerRegistry(workers_dir=tmp)
            reg.load_all(self.model, self.mcp_tools, self.custom_tools)
            assert len(reg.list_workers()) == 1

            md.unlink()
            reg.unregister("d")
            assert len(reg.list_workers()) == 0

    def test_tool_mapping_with_keys(self):
        """tool_keys 白名单过滤正确."""
        with tempfile.TemporaryDirectory() as tmp:
            _write_md(Path(tmp) / "a.md", """\
---
id: a
tool_keys:
  - mock_web_fetch
---

You are A.
""")
            reg = WorkerRegistry(workers_dir=tmp)
            reg.load_all(self.model, self.mcp_tools, self.custom_tools)

            workers = reg.list_enabled()
            assert len(workers) == 1

            from xihe_agent.registry.registry import _get_tools_for_worker
            tools = _get_tools_for_worker(workers[0], self.mcp_tools, self.custom_tools)
            tool_names = [t.name for t in tools]
            assert "mock_web_fetch" in tool_names
            assert "mock_edit_file" not in tool_names
            assert "generate_image" in tool_names
