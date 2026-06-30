from typing import TYPE_CHECKING, Optional

from langchain.agents import create_agent as create_react_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.tools import BaseTool
from langgraph.graph import StateGraph
from langgraph_supervisor import create_supervisor

if TYPE_CHECKING:
    from xihe_agent.registry.registry import WorkerRegistry

from loguru import logger

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


def build_supervisor(
    model: BaseChatModel,
    all_mcp_tools: list[BaseTool],
    custom_tools: list[BaseTool],
    registry: Optional["WorkerRegistry"] = None,
) -> StateGraph:
    from xihe_agent.registry.registry import _get_tools_for_worker

    if registry is not None:
        workers = registry.list_enabled()
    else:
        workers = None

    if workers:
        sub_agents = []
        for config in workers:
            tools = _get_tools_for_worker(config, all_mcp_tools, custom_tools)
            sub_agents.append(
                create_react_agent(
                    model, tools=tools, name=config.id, system_prompt=config.system_prompt,
                )
            )
        descriptions = "\n".join(
            f"- **{w.id}**: {w.description}" for w in workers
        )
    else:
        if registry is not None:
            logger.info("Registry has no enabled workers, using built-in agents")
        sub_agents = []
        for w in _BUILTIN_WORKERS:
            sub_agents.append(
                create_react_agent(
                    model, tools=list(all_mcp_tools) + list(custom_tools),
                    name=w["id"], system_prompt=w["prompt"],
                )
            )
        descriptions = "\n".join(
            f"- **{w['id']}**: {w['description']}" for w in _BUILTIN_WORKERS
        )

    supervisor_prompt = (
        "You are a supervisor managing specialized agents.\n\n"
        "## Available Agents\n"
        f"{descriptions}\n\n"
        "## Protocol\n"
        "1. Analyze the user request and delegate to the best-suited agent.\n"
        "2. If a result needs refinement, delegate to another agent.\n"
        "3. Synthesize results into a coherent response.\n"
        "Default language: Chinese (zh-CN)."
    )

    workflow = create_supervisor(
        sub_agents,
        model=model,
        prompt=supervisor_prompt,
        output_mode="last_message",
        parallel_tool_calls=False,
    )

    return workflow.compile()
