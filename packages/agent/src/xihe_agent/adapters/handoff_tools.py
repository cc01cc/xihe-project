"""task-40 §3 batch 2 (D-1884 / D-1885): agent-initiated dispatch by DISPLAY NAME.

Two tools, deliberately separate:

* ``list_session_participants`` reads the roster from CP. The model may only name somebody it has
  actually READ — a roster snapshot pasted into the prompt would move name resolution out of CP and
  rot the day the model or the copy changes (Lead 2026-11-19: 名字来源必须是它自己读到的).
* ``dispatch_agent_task`` is TO: the named participant starts its own run and answers.

CC (notify-only, "just telling somebody") is deliberately NOT a field of the dispatch tool. One tool
carrying both would make the model unsure whether it is assigning work or copying somebody, and that
ambiguity is the one thing this batch must not add. A notify face gets its own tool when it is needed.

Transport is CP's internal service-Bearer face; resolution of the display name happens in CP (the
same roster ``MentionParser`` resolves against), and an unresolved name comes back as
``reason=mention_unresolved`` — the parser's existing vocabulary, never a new code invented here.

Gray-release seam, copied from the team-task board (task-188 MVP⑤): the client is injected as
``context.metadata[HANDOFF_CLIENT_KEY]``. Absent (CP not configured, or assembly failed) ⇒ both tools
answer ``HANDOFF_CLIENT_UNAVAILABLE``, which is exactly the pre-batch behavior.
"""

from __future__ import annotations

from typing import Any

from xihe_agent.interfaces.tool import BaseAgentTool, ToolSpec

# Injected callable: async (tool_name, arguments) -> dict. Absent = not wired.
HANDOFF_CLIENT_KEY = "_handoff_client"

TOOL_LIST_PARTICIPANTS = "list_session_participants"
TOOL_DISPATCH = "dispatch_agent_task"

CODE_CLIENT_UNAVAILABLE = "HANDOFF_CLIENT_UNAVAILABLE"


def _client(context: Any) -> Any | None:
    metadata = getattr(context, "metadata", None)
    if not isinstance(metadata, dict):
        return None
    client = metadata.get(HANDOFF_CLIENT_KEY)
    return client if callable(client) else None


def _unavailable(tool: str) -> dict[str, Any]:
    return {
        "status": "error",
        "code": CODE_CLIENT_UNAVAILABLE,
        "message": (
            f"{tool} is unavailable in this run: the CP hand-off client is not wired "
            "(XIHE_CP_URL unset or assembly failed). Nothing was dispatched."
        ),
    }


class ListSessionParticipantsTool(BaseAgentTool):
    """Read the session roster: display names, kind, role, disabled."""

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name=TOOL_LIST_PARTICIPANTS,
            description=(
                "Read the participant list (roster) of THIS conversation. Call it before naming "
                "someone in dispatch_agent_task: the display names you see here are exactly the "
                "ones the platform resolves, and a name you did not read here will not resolve. "
                "Disabled participants are listed with disabled=true; naming them does not wake "
                "them."
            ),
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
        )

    async def execute(self, input: dict[str, Any], context: Any) -> dict[str, Any]:
        client = _client(context)
        if client is None:
            return _unavailable(TOOL_LIST_PARTICIPANTS)
        return await client(TOOL_LIST_PARTICIPANTS, dict(input or {}))


class DispatchAgentTaskTool(BaseAgentTool):
    """TO the named participant: it starts its own run and answers (not a CC)."""

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name=TOOL_DISPATCH,
            description=(
                "Assign a concrete piece of work to a participant of THIS conversation (TO "
                "semantics: their agent starts its own run and answers you). Use it when the work "
                "belongs to somebody else; do not use it to merely inform or copy someone. "
                "target_display_name must be a name you read from list_session_participants. "
                "The instruction must be self-contained: the receiver sees it as the body of a "
                "message in this conversation and does NOT see your reasoning."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "target_display_name": {
                        "type": "string",
                        "description": "Display name exactly as read from list_session_participants.",
                    },
                    "instruction": {
                        "type": "string",
                        "description": "Self-contained instruction: what to do, and what to report back.",
                    },
                },
                "required": ["target_display_name", "instruction"],
                "additionalProperties": False,
            },
        )

    async def execute(self, input: dict[str, Any], context: Any) -> dict[str, Any]:
        client = _client(context)
        if client is None:
            return _unavailable(TOOL_DISPATCH)
        return await client(TOOL_DISPATCH, dict(input or {}))


def handoff_tool_faces() -> list[BaseAgentTool]:
    """The two faces this batch adds, in the order the model should meet them."""
    return [ListSessionParticipantsTool(), DispatchAgentTaskTool()]
