"""One-shot, test-only LangGraph continuation failpoints.

This module is inert unless the exact Host checkpoint-resume profile is enabled.
It never records tool input/output and only exposes the armed stage and paused bit.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import Literal

Failpoint = Literal["before_tool_dispatch", "after_tool_dispatch"]
_TEST_TOOL_NAMES = frozenset({"write_file", "remote_mutate"})


@dataclass
class _ArmedFailpoint:
    stage: Failpoint
    paused: asyncio.Event
    resume: asyncio.Event


_armed: _ArmedFailpoint | None = None
_lock = asyncio.Lock()


def enabled() -> bool:
    return (
        os.getenv("XIHE_ENV") == "dev"
        and os.getenv("XIHE_E2E_PROFILE") == "host"
        and os.getenv("XIHE_E2E_CHECKPOINT_RESUME") == "1"
    )


async def arm(stage: Failpoint) -> None:
    global _armed
    if not enabled():
        raise RuntimeError("checkpoint resume failpoints are disabled")
    async with _lock:
        if _armed is not None:
            raise RuntimeError("a checkpoint resume failpoint is already armed")
        _armed = _ArmedFailpoint(stage=stage, paused=asyncio.Event(), resume=asyncio.Event())


async def status() -> dict[str, object]:
    async with _lock:
        current = _armed
        return {
            "enabled": enabled(),
            "armed": current is not None,
            "paused": current.paused.is_set() if current is not None else False,
            "stage": current.stage if current is not None else None,
        }


async def release() -> None:
    global _armed
    async with _lock:
        current = _armed
        _armed = None
        if current is not None:
            current.resume.set()


async def pause_if_armed(stage: Failpoint, tool_name: str) -> None:
    global _armed
    if not enabled() or tool_name not in _TEST_TOOL_NAMES:
        return
    async with _lock:
        current = _armed
        if current is None or current.stage != stage:
            return
        current.paused.set()
    await current.resume.wait()
    async with _lock:
        if _armed is current:
            _armed = None
