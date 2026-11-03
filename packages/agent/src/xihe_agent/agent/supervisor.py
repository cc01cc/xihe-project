"""Supervisor orchestration built on our own graph builder.

PLAN-0633 batch E: this module used to delegate to
``langgraph_supervisor.create_supervisor``. That package is deprecated upstream
(its README points at "the supervisor pattern directly via tools") and has had
no release for 11+ months, so the dependency is gone and the graph is assembled
here from the same primitives the rest of the agent already uses:

* every participant (supervisor + specialists) is a ``create_agent`` graph built
  through :func:`xihe_agent.agent_runner.graph_builder.build_react_graph`, which
  stays the single owner of direct ``create_react_agent`` calls (PLAN-0473);
* routing is tool-based handoff: each specialist gets a ``transfer_to_<id>``
  tool that returns ``Command(goto=<id>, graph=Command.PARENT)``, and control
  returns to the supervisor after the specialist finishes.

Frozen constraints (do not "improve" these without a new decision):

* **No checkpointer.** ``checkpoint_saver.SAFE_REACT_NODE_NAMES`` only whitelists
  the single-agent nodes (``model``/``tools``) plus framework sentinels, so a
  supervisor graph must not be attached to the CP-mediated saver in v1.
* **Approval is unsupported on this path.** ``api/chat.py`` fails closed with
  ``ApprovalExecutorUnsupportedError`` before the supervisor executor is ever
  built, so ``/chat`` never reaches this graph today (see
  ``spec/agent/agent-module-boundaries.md``).
* ``create_supervisor`` bound the model with ``parallel_tool_calls=False``; that
  binding is not reproducible through ``create_agent`` without wrapping the
  model. If a model emits several handoffs in one turn, langgraph applies the
  last ``Command`` — acceptable while the path is unreachable, and it must be
  revisited (with a real runtime test) if the supervisor executor is ever wired
  to ``/chat``.
* ``create_supervisor(output_mode="last_message")`` trimmed the returned
  transcript to its last message. Here the full transcript is returned; nothing
  consumes this path today, and the complete history is the better default for
  debugging. The routing turn (supervisor ``AIMessage`` + handoff
  ``ToolMessage``) is *not* merged into the parent transcript when a handoff
  fires — that is inherent to ``Command(graph=Command.PARENT)`` and is the same
  mechanism ``create_supervisor`` used (it keeps the specialist's answer and the
  next supervisor turn).
"""

from typing import TYPE_CHECKING, Optional

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.tools import BaseTool, tool
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command
from loguru import logger

from xihe_agent.agent_runner.graph_builder import adapt_agent_tools, build_react_graph
from xihe_agent.interfaces.tool import BaseAgentTool

if TYPE_CHECKING:
    from xihe_agent.registry.registry import WorkerRegistry

GENERAL_PROMPT = "You are the main xihe Agent assistant. Use available tools to help users."

RESEARCH_PROMPT = """You are a research specialist. Use web_fetch and extract_pdf_text to gather information.
- For web content: use web_fetch to retrieve and convert to markdown
- For PDF files: use extract_pdf_text to extract text content
- Summarize findings clearly for the user"""

CODE_PROMPT = """You are a code specialist. Use file editing tools to help with programming tasks.
- read_file_range: view file contents with line numbers
- edit_file: search and replace text in files
- Use write_file for creating new files
- Always show diffs of changes made"""

_BUILTIN_WORKERS: list[dict] = [
    {"id": "general_agent", "prompt": GENERAL_PROMPT, "description": "General conversation and tool calls"},
    {"id": "research_agent", "prompt": RESEARCH_PROMPT, "description": "Web research, PDF extraction"},
    {"id": "code_agent", "prompt": CODE_PROMPT, "description": "Code generation and file editing"},
]

SUPERVISOR_NODE = "supervisor"

# One worker: (node id, description for the routing prompt, system prompt, tools).
_Worker = tuple[str, str, str, list[BaseAgentTool]]


def _handoff_tool(worker_id: str, description: str) -> BaseTool:
    """A handoff tool that moves the parent graph to ``worker_id``.

    Returning ``Command(goto=..., graph=Command.PARENT)`` is the tool-based
    handoff pattern: the tool runs inside the supervisor subgraph, the command
    is applied to the parent graph that owns the specialist nodes.
    """

    @tool(f"transfer_to_{worker_id}", description=f"Hand the next step to '{worker_id}' ({description}).")
    def handoff() -> Command:
        logger.debug("Supervisor handoff -> {}", worker_id)
        return Command(goto=worker_id, graph=Command.PARENT)

    return handoff


def _supervisor_prompt(workers: list[_Worker]) -> str:
    descriptions = "\n".join(f"- **{worker_id}**: {description}" for worker_id, description, _p, _t in workers)
    return (
        "You are a supervisor managing specialized agents.\n\n"
        "## Available Agents\n"
        f"{descriptions}\n\n"
        "## Protocol\n"
        "1. Analyze the user request and delegate to the best-suited agent.\n"
        "2. If a result needs refinement, delegate to another agent.\n"
        "3. Synthesize results into a coherent response.\n"
        "Default language: Chinese (zh-CN)."
    )


def _collect_workers(
    all_mcp_tools: list[BaseAgentTool],
    custom_tools: list[BaseAgentTool],
    registry: Optional["WorkerRegistry"],
) -> list[_Worker]:
    from xihe_agent.registry.registry import get_tools_for_worker

    workers = registry.list_enabled() if registry is not None else None
    if workers:
        return [
            (config.id, config.description, config.system_prompt, get_tools_for_worker(config, all_mcp_tools, custom_tools))
            for config in workers
        ]
    if registry is not None:
        logger.info("Registry has no enabled workers, using built-in agents")
    shared_tools = list(all_mcp_tools) + list(custom_tools)
    return [(w["id"], w["description"], w["prompt"], shared_tools) for w in _BUILTIN_WORKERS]


def build_supervisor(
    model: BaseChatModel,
    all_mcp_tools: list[BaseAgentTool],
    custom_tools: list[BaseAgentTool],
    registry: Optional["WorkerRegistry"] = None,
) -> CompiledStateGraph:
    """Build the supervisor graph (supervisor + one node per specialist).

    No checkpointer is attached (see the module docstring); participants are
    compiled ``create_agent`` graphs, so a failure to build one is raised
    instead of silently degrading into a supervisor with a missing specialist.
    """
    workers = _collect_workers(all_mcp_tools, custom_tools, registry)
    handoff_tools = [_handoff_tool(worker_id, description) for worker_id, description, _p, _t in workers]

    supervisor_agent = build_react_graph(
        model,
        handoff_tools,
        name=SUPERVISOR_NODE,
        system_prompt=_supervisor_prompt(workers),
    )
    if supervisor_agent is None:
        raise RuntimeError("supervisor graph could not be built")

    builder: StateGraph = StateGraph(MessagesState)
    builder.add_node(SUPERVISOR_NODE, supervisor_agent)
    for worker_id, _description, system_prompt, tools in workers:
        worker_graph = build_react_graph(
            model,
            adapt_agent_tools(tools),
            name=worker_id,
            system_prompt=system_prompt,
        )
        if worker_graph is None:
            raise RuntimeError(f"supervisor worker '{worker_id}' graph could not be built")
        builder.add_node(worker_id, worker_graph)
        # A specialist hands control back to the supervisor, which either routes
        # again or ends the run with the synthesised answer.
        builder.add_edge(worker_id, SUPERVISOR_NODE)

    builder.add_edge(START, SUPERVISOR_NODE)
    builder.add_edge(SUPERVISOR_NODE, END)
    return builder.compile()
