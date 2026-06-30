from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from xihe_agent.main import app


def pytest_configure(config):
    config.addinivalue_line("markers", "integration: CP integration tests (require running CP)")
    config.addinivalue_line("markers", "docker: tests that require Docker")


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
