from pathlib import Path

from langchain.agents import create_agent as create_react_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.tools import BaseTool
from langgraph.graph.state import CompiledStateGraph
from loguru import logger

from xihe_agent.registry import RegistryEntry, WorkerConfig, WorkerStatus
from xihe_agent.registry.loader import parse_markdown_worker, scan_workers_dir

DEFAULT_WORKERS_DIR = "./agents"


class WorkerRegistry:
    _entries: dict[str, RegistryEntry]
    _workers_dir: str

    def __init__(self, workers_dir: str | None = None):
        self._workers_dir = workers_dir or DEFAULT_WORKERS_DIR
        self._entries = {}

    @property
    def workers_dir(self) -> str:
        return self._workers_dir

    def load_all(
        self,
        model: BaseChatModel,
        all_mcp_tools: list[BaseTool],
        custom_tools: list[BaseTool],
    ) -> None:
        configs = scan_workers_dir(self._workers_dir)
        for config in configs:
            self.register(config, model, all_mcp_tools, custom_tools)
        logger.info("Registry loaded %d worker(s)", len(self._entries))

    def list_workers(self) -> list[WorkerStatus]:
        return [
            WorkerStatus(
                id=entry.config.id,
                name=entry.config.name,
                description=entry.config.description,
                enabled=entry.config.enabled,
                file_path=entry.config.file_path,
                error=None if entry.graph else "Graph not initialized",
            )
            for entry in self._entries.values()
        ]

    def list_enabled(self) -> list[WorkerConfig]:
        return [
            entry.config
            for entry in self._entries.values()
            if entry.config.enabled and entry.graph is not None
        ]

    def get_worker(self, worker_id: str) -> CompiledStateGraph | None:
        entry = self._entries.get(worker_id)
        if entry is None:
            return None
        if not entry.config.enabled:
            return None
        return entry.graph

    def enable(
        self,
        worker_id: str,
        model: BaseChatModel,
        all_mcp_tools: list[BaseTool],
        custom_tools: list[BaseTool],
    ) -> bool:
        entry = self._entries.get(worker_id)
        if entry is None:
            logger.warning("Cannot enable unknown worker '%s'", worker_id)
            return False
        entry.config.enabled = True
        _persist_enabled(entry.config)
        if entry.graph is None:
            graph = _build_worker_graph(entry.config, model, all_mcp_tools, custom_tools)
            if graph is not None:
                entry.graph = graph
        logger.info("Worker '%s' enabled", worker_id)
        return True

    def disable(self, worker_id: str) -> bool:
        entry = self._entries.get(worker_id)
        if entry is None:
            logger.warning("Cannot disable unknown worker '%s'", worker_id)
            return False
        entry.config.enabled = False
        _persist_enabled(entry.config)
        logger.info("Worker '%s' disabled", worker_id)
        return True

    def reload(
        self,
        worker_id: str,
        model: BaseChatModel,
        all_mcp_tools: list[BaseTool],
        custom_tools: list[BaseTool],
    ) -> bool:
        entry = self._entries.get(worker_id)
        if entry is None:
            logger.warning("Cannot reload unknown worker '%s'", worker_id)
            return False
        config = parse_markdown_worker(entry.config.file_path)
        if config is None:
            logger.error("Reload failed for '%s': cannot parse %s", worker_id, entry.config.file_path)
            return False
        graph = _build_worker_graph(config, model, all_mcp_tools, custom_tools)
        self._entries[worker_id] = RegistryEntry(config=config, graph=graph)
        logger.info("Worker '%s' reloaded", worker_id)
        return True

    def register(
        self,
        config: WorkerConfig,
        model: BaseChatModel,
        all_mcp_tools: list[BaseTool],
        custom_tools: list[BaseTool],
    ) -> None:
        if config.id in self._entries:
            logger.warning("Overwriting existing worker '%s'", config.id)
        graph = _build_worker_graph(config, model, all_mcp_tools, custom_tools)
        self._entries[config.id] = RegistryEntry(config=config, graph=graph)
        logger.info("Worker '%s' registered (%d tool(s))", config.id,
                     len(_get_tools_for_worker(config, all_mcp_tools, custom_tools)))

    def unregister(self, worker_id: str) -> bool:
        if worker_id not in self._entries:
            logger.warning("Cannot unregister unknown worker '%s'", worker_id)
            return False
        del self._entries[worker_id]
        logger.info("Worker '%s' unregistered", worker_id)
        return True


def _get_tools_for_worker(
    config: WorkerConfig,
    all_mcp_tools: list[BaseTool],
    custom_tools: list[BaseTool],
) -> list[BaseTool]:
    if config.tool_keys:
        mcp = [t for t in all_mcp_tools if t.name in config.tool_keys]
        return mcp + list(custom_tools)
    return list(all_mcp_tools) + list(custom_tools)


def _build_worker_graph(
    config: WorkerConfig,
    model: BaseChatModel,
    all_mcp_tools: list[BaseTool],
    custom_tools: list[BaseTool],
) -> CompiledStateGraph | None:
    tools = _get_tools_for_worker(config, all_mcp_tools, custom_tools)
    logger.debug("Building graph for '%s' with %d tool(s)", config.id, len(tools))
    try:
        return create_react_agent(
            model,
            tools=tools,
            name=config.id,
            system_prompt=config.system_prompt,
        )
    except Exception as e:
        logger.error("Failed to create graph for worker '%s': %s", config.id, e, exc_info=True)
        return None


def _persist_enabled(config: WorkerConfig) -> None:
    if not config.file_path:
        return
    path = Path(config.file_path)
    if not path.exists():
        return
    try:
        text = path.read_text(encoding="utf-8")
        import re
        new_text = re.sub(
            r"^enabled:\s*(true|false)",
            f"enabled: {str(config.enabled).lower()}",
            text,
            count=1,
            flags=re.MULTILINE,
        )
        if new_text == text:
            new_text = text.replace("---\n", f"---\nenabled: {str(config.enabled).lower()}\n", 1)
        path.write_text(new_text, encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        logger.warning("Failed to persist enabled state for %s: %s", config.file_path, e)
