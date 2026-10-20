"""PLAN-0539: a hostile ``NO_PROXY`` must not break agent startup.

The host injects ``[::1]`` into every child process; httpx parses each
``NO_PROXY`` entry as a URL while *constructing* a client, so a bracketed IPv6
entry aborted startup at import time (``InvalidURL: Invalid port: ':1]'``).
These tests pin both halves of the fix: the entry-point normalization and the
``trust_env=False`` on clients that only talk to CP on localhost.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from xihe_agent.context.store_client import CPContextServiceClient, CPEventStoreClient
from xihe_agent.env_sanitize import sanitize_no_proxy_env, sanitize_no_proxy_value

HOSTILE = "localhost,127.0.0.1,::1,[::1]"
AGENT_ROOT = Path(__file__).resolve().parents[2]


def _run_python(code: str, no_proxy: str) -> subprocess.CompletedProcess[str]:
    """Run ``code`` in a fresh interpreter whose inherited env is hostile."""
    env = {**os.environ, "NO_PROXY": no_proxy, "no_proxy": no_proxy}
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=AGENT_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("[::1],localhost", "localhost"),
        ("localhost,::1,[::1]", "localhost,::1"),
        ("[::1]", ""),
        ("localhost,127.0.0.1", "localhost,127.0.0.1"),
    ],
)
def test_sanitize_drops_only_bracketed_entries(raw: str, expected: str) -> None:
    """Bare ``::1`` is valid and must survive; only bracketed entries are dropped."""
    assert sanitize_no_proxy_value(raw) == expected


def test_sanitize_removes_variable_when_nothing_survives() -> None:
    """An empty value would mean something else to httpx, so the key is removed."""
    env = {"NO_PROXY": "[::1]", "no_proxy": "[::1]", "PATH": "/bin"}
    changes = sanitize_no_proxy_env(env)

    assert "NO_PROXY" not in env
    assert "no_proxy" not in env
    assert env["PATH"] == "/bin"
    assert changes == {"NO_PROXY": None, "no_proxy": None}


def test_sanitize_leaves_clean_values_untouched() -> None:
    env = {"NO_PROXY": "localhost,127.0.0.1,::1"}
    assert sanitize_no_proxy_env(env) == {}
    assert env["NO_PROXY"] == "localhost,127.0.0.1,::1"


@pytest.mark.parametrize("client_type", [CPContextServiceClient, CPEventStoreClient])
def test_internal_clients_ignore_env_proxies(client_type: type) -> None:
    """CP clients only talk to localhost, so they must not read proxy env at all."""
    client = client_type(base_url="http://localhost:1", api_token="test-token")

    # Both inspected attributes are the only observable effect of trust_env.
    assert client._client._trust_env is False  # noqa: SLF001 - asserting the setting itself
    assert client._client._mounts == {}  # noqa: SLF001 - no proxy mounts


def test_package_import_cleans_hostile_env() -> None:
    """Importing the package repairs ``NO_PROXY`` before any client is built."""
    result = _run_python("import xihe_agent, os; print(os.environ.get('NO_PROXY', '<unset>'))", HOSTILE)

    assert result.returncode == 0, result.stderr
    assert "[" not in result.stdout
    assert "::1" in result.stdout


def test_main_imports_under_hostile_env() -> None:
    """The whole composition root — which builds CP clients at import — must load."""
    result = _run_python("import xihe_agent.main; print('IMPORT_OK')", HOSTILE)

    assert result.returncode == 0, result.stderr
    assert "IMPORT_OK" in result.stdout
    assert "InvalidURL" not in result.stderr
