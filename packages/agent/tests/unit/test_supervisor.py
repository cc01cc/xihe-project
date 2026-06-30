from unittest.mock import AsyncMock, MagicMock

import pytest
from langchain_core.tools import tool

from xihe_agent.agent.supervisor import (
    CODE_PROMPT,
    GENERAL_PROMPT,
    RESEARCH_PROMPT,
    build_supervisor,
)


def test_prompts_defined():
    assert len(GENERAL_PROMPT) > 50
    assert len(RESEARCH_PROMPT) > 50
    assert len(CODE_PROMPT) > 50


@tool
def mock_tool() -> str:
    """A mock tool for testing."""
    return "mock result"


@pytest.mark.asyncio
async def test_build_supervisor_no_registry():
    model = MagicMock()
    model.agenerate = AsyncMock()
    supervisor = build_supervisor(model, [mock_tool], [])
    assert supervisor is not None
