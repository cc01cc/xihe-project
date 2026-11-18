"""task-82 (D-1884): CP-owned conditional faces join the one table the provider sees.

The board faces (task-188) and the roster/dispatch faces (task-40 batch 2) are offered
only when their CP client is wired. That injection used to live in
LangGraphRunner.stream, which builds the graph's executable tool table, while the
outbound provider request body is assembled from the tool list api/chat.py puts into
RunnerConfig.tools (and the ToolSpec list derived from it). A controlled perturbation
settled which table is authoritative: with the dispatch face un-injected the run table
held 4 faces and chat_run_provider_requests.tool_count was 0; fully wired the table held
42 while the request still carried 36. Injected faces were executable but invisible, so
the model could not call them, which is why task-40 batch 2 measured 0/3.

Default grant set (workspace permission discipline: grant set plus hit-source audit, not
a tool_mode special case): a run is offered every CP-owned face whose client wired
successfully, independent of toolMode, because these faces belong to the control plane
rather than to the workspace file sandbox. Faces are named explicitly in GRANT_SET; a
client that fails to wire or an unconfigured host grants nothing, which keeps the gray
behaviour of task-188 G3-a. Every call logs which faces were granted and for which runId
(event=conditional_faces), and each failed face logs its own unwired reason.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from loguru import logger

from xihe_agent.adapters.handoff_tools import HANDOFF_CLIENT_KEY, handoff_tool_faces
from xihe_agent.adapters.team_task_tools import TEAM_TASK_CLIENT_KEY
from xihe_agent.agent_runner.handoff_client import build_handoff_client
from xihe_agent.agent_runner.team_task_client import build_team_task_client, team_task_tool_faces
from xihe_agent.interfaces.tool import BaseAgentTool

#: The default grant set: each entry names a CP-owned face group, the context.metadata key
#: holding its client, the builder that wires it, and the faces it contributes. Appending a
#: new CP-owned face means adding one row here; nothing branches on toolMode.
GRANT_SET: tuple[tuple[str, str, Callable[[Any], Any], Callable[[], list[BaseAgentTool]]], ...] = (
    ("team_task", TEAM_TASK_CLIENT_KEY, build_team_task_client, team_task_tool_faces),
    ("handoff", HANDOFF_CLIENT_KEY, build_handoff_client, handoff_tool_faces),
)


def _wire_client(context: Any, label: str, key: str, builder: Callable[[Any], Any]) -> bool:
    """Return True when this run may see the face group; never raise into the run."""
    if callable(context.metadata.get(key)):
        return True
    try:
        client = builder(context)
    except Exception as exc:
        logger.warning(
            "[LIFECYCLE] service=agent event=conditional_face_unwired face={} reason=assembly_failed errorType={}",
            label,
            type(exc).__name__,
        )
        return False
    if client is None:
        # The builders return None for their documented gray seams (no XIHE_CP_URL, no
        # runId): absence is the grant, so it is recorded rather than treated as failure.
        logger.info("[LIFECYCLE] service=agent event=conditional_face_not_granted face={} reason=client_absent", label)
        return False
    context.metadata[key] = client
    return True


def detach_conditional_faces(context: Any) -> None:
    """Drop every run-scoped client this run was granted.

    The clients carry this run's identity (runId-scoped CP calls), so a context object that
    outlives the run must not hand them to the next one; the keys are the grant set's own,
    so a new face group is cleaned up without touching this function.
    """
    for _label, key, _builder, _faces in GRANT_SET:
        context.metadata.pop(key, None)


def attach_conditional_faces(context: Any, tools: Sequence[BaseAgentTool]) -> list[BaseAgentTool]:
    """Return tools plus every granted CP-owned face, deduplicated by spec name.

    Both call sites (the api/chat.py assembly point and the runner) share this function, so
    the provider request table and the graph execution table cannot drift apart again. The
    dedup makes the second call a no-op on faces while still refreshing the audit log.
    """
    attached: list[BaseAgentTool] = list(tools)
    seen = {tool.spec.name for tool in attached}
    granted: list[str] = []
    for label, key, builder, faces in GRANT_SET:
        if not _wire_client(context, label, key, builder):
            continue
        granted.append(label)
        for face in faces():
            name = face.spec.name
            if name in seen:
                continue
            seen.add(name)
            attached.append(face)
    logger.info(
        "[LIFECYCLE] service=agent event=conditional_faces runId={} granted={} added={} total={}",
        context.metadata.get("runId"),
        ",".join(granted) or "none",
        len(attached) - len(tools),
        len(attached),
    )
    return attached
