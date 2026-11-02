from collections.abc import Iterator
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from xihe_agent import config_state
from xihe_agent.main import app

_CONFIG_READY_REPORT = {
    "ok": True,
    "domains": {"llm-provider": {"status": "ok", "revision": "test", "source": "test"}},
    "revision": "test",
    "refreshed": True,
    "degraded": [],
}


def pytest_configure(config):
    config.addinivalue_line("markers", "integration: CP integration tests (require running CP)")
    config.addinivalue_line("markers", "docker: tests that require Docker")


@pytest.fixture(autouse=True)
def config_ready_baseline() -> Iterator[None]:
    """Unit/integration tests never run the lifespan, so config is "already loaded".

    PLAN-0632 D32-27 Step 2 gates chat on `config_state`: the real process reaches READY during
    the lifespan startup sync, which `TestClient` does not run. Without this baseline every chat
    test would attempt a real CP sync (and fail closed, correctly, but for the wrong reason).

    Tests that assert the state machine itself call `config_state.reset_for_tests()` in their own
    (module-level) fixture, which is set up after this one and therefore wins.
    """
    config_state.note_startup_result(_CONFIG_READY_REPORT)
    yield
    config_state.reset_for_tests()


@pytest.fixture
def mock_mcp_client():
    client = AsyncMock()
    client.tools = []
    client.initialized = True
    client.initialize = AsyncMock()
    client.reinitialize = AsyncMock()
    client.ensure_ready = AsyncMock()
    return client


@pytest.fixture
def test_client():
    return TestClient(app)
