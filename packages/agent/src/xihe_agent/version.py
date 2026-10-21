"""Single source for the Agent's own version and build commit.

PLAN-0534: the authoritative version is ``pyproject.toml``; the installed
distribution metadata is the runtime projection of that manifest. Business
code must never carry a version literal.
"""

import os
import re
from functools import lru_cache
from importlib.metadata import PackageNotFoundError, version

from loguru import logger

PACKAGE_NAME = "xihe-agent"
_COMMIT_RE = re.compile(r"^[0-9a-fA-F]{7,40}$")


@lru_cache(maxsize=1)
def agent_version() -> str:
    """Return the installed ``xihe-agent`` version, or ``unknown`` if metadata is absent."""
    try:
        return version(PACKAGE_NAME)
    except PackageNotFoundError:
        logger.warning("Agent package metadata not found for {}; reporting unknown version", PACKAGE_NAME)
        return "unknown"


def build_commit() -> str | None:
    """Return the injected build commit, or ``None`` when absent/invalid (never fabricate)."""
    raw = os.getenv("XIHE_BUILD_COMMIT", "").strip()
    return raw if _COMMIT_RE.fullmatch(raw) else None
