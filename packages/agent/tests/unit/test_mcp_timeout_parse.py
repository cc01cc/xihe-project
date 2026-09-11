"""PLAN-301 M1: fail-closed timeout parsing (decision #4).

Invalid or non-positive XIHE_MCP_TOOL_TIMEOUT_S values must degrade to the
default (30s) with a warning — never produce an unbounded or negative wait.
"""

import importlib

import pytest


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, 30.0),
        ("", 30.0),
        ("45", 45.0),
        ("90.5", 90.5),
        ("abc", 30.0),
        ("-5", 30.0),
        ("0", 30.0),
    ],
)
def test_parse_timeout_s_fail_closed(raw, expected):
    from xihe_agent.adapters.mcp_client import _parse_timeout_s

    assert _parse_timeout_s(raw, default=30.0) == expected


def test_default_constant_parsed_from_env(monkeypatch):
    import os

    monkeypatch.setenv("XIHE_MCP_TOOL_TIMEOUT_S", "60")
    from xihe_agent.adapters import mcp_client

    importlib.reload(mcp_client)
    assert mcp_client.DEFAULT_MCP_TOOL_TIMEOUT_S == 60.0

    monkeypatch.setenv("XIHE_MCP_TOOL_TIMEOUT_S", "not-a-number")
    importlib.reload(mcp_client)
    assert mcp_client.DEFAULT_MCP_TOOL_TIMEOUT_S == 30.0

    monkeypatch.delenv("XIHE_MCP_TOOL_TIMEOUT_S")
    importlib.reload(mcp_client)
    assert mcp_client.DEFAULT_MCP_TOOL_TIMEOUT_S == 30.0
