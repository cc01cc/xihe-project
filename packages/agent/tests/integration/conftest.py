"""Integration-test shared fixtures.

Windows: psycopg async mode cannot run on the default ProactorEventLoop, so
the pytest-asyncio session ``event_loop_policy`` is overridden with the
Selector policy for the whole integration scope (PLAN-0485 T4.1).
"""

import asyncio
import sys

import pytest


@pytest.fixture(scope="session")
def event_loop_policy():
    if sys.platform == "win32":
        return asyncio.WindowsSelectorEventLoopPolicy()
    return asyncio.get_event_loop_policy()
