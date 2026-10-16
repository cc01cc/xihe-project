from __future__ import annotations

import asyncio

import pytest

from xihe_agent.agent_runner import checkpoint_resume_failpoint


@pytest.mark.asyncio
async def test_armed_failpoint_pauses_and_releases_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XIHE_ENV", "dev")
    monkeypatch.setenv("XIHE_E2E_PROFILE", "host")
    monkeypatch.setenv("XIHE_E2E_CHECKPOINT_RESUME", "1")
    await checkpoint_resume_failpoint.arm("before_tool_dispatch")
    armed = checkpoint_resume_failpoint._armed
    assert armed is not None

    pause = asyncio.create_task(checkpoint_resume_failpoint.pause_if_armed("before_tool_dispatch", "write_file"))
    try:
        await asyncio.wait_for(armed.paused.wait(), timeout=1)
        assert (await checkpoint_resume_failpoint.status())["paused"] is True
    finally:
        await checkpoint_resume_failpoint.release()

    await asyncio.wait_for(pause, timeout=1)
    assert (await checkpoint_resume_failpoint.status())["armed"] is False
