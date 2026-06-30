from dataclasses import dataclass, field

from langgraph.graph.state import CompiledStateGraph


@dataclass
class WorkerConfig:
    id: str
    name: str
    description: str
    enabled: bool = True
    system_prompt: str = ""
    file_path: str = ""
    tool_keys: list[str] = field(default_factory=list)


@dataclass
class WorkerStatus:
    id: str
    name: str
    description: str
    enabled: bool
    file_path: str
    error: str | None = None


@dataclass
class RegistryEntry:
    config: WorkerConfig
    graph: CompiledStateGraph | None = None


__all__ = [
    "WorkerConfig",
    "WorkerStatus",
    "RegistryEntry",
]
