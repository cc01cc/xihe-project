import os
import tempfile
from pathlib import Path

import pytest
from loguru import logger

from xihe_agent.dotenv_loader import (
    find_project_root,
    interpolate,
    load_project_env,
    parse_cli_overrides,
)


@pytest.fixture(autouse=True)
def _restore_environ():
    """The loader writes real os.environ; restore the full snapshot per test."""
    original = dict(os.environ)
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(original)


@pytest.fixture
def tmp_project(monkeypatch):
    """Temp project root with cwd restored before cleanup (Windows-safe)."""
    original = Path.cwd()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        monkeypatch.chdir(root)
        try:
            yield root
        finally:
            monkeypatch.chdir(original)


def _capture_loguru():
    messages: list[str] = []
    handler_id = logger.add(lambda message: messages.append(message), level="WARNING")
    return messages, handler_id


def test_find_project_root_found():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / ".env.dev").touch()
        result = find_project_root(root)
        assert result == root


def test_find_project_root_marker_env():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / ".env").touch()
        result = find_project_root(root)
        assert result == root


def test_find_project_root_not_found():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        result = find_project_root(root)
        assert result is None


def test_find_project_root_stops_at_git():
    with tempfile.TemporaryDirectory() as tmp:
        parent = Path(tmp)
        (parent / ".git").mkdir()
        sub = parent / "sub" / "deep"
        sub.mkdir(parents=True)
        result = find_project_root(sub)
        assert result is None


def test_find_project_root_stops_before_git_boundary():
    with tempfile.TemporaryDirectory() as tmp:
        parent = Path(tmp)
        (parent / ".git").mkdir()
        (parent / ".env.dev").touch()
        sub = parent / "sub"
        sub.mkdir()
        result = find_project_root(sub)
        assert result == parent


def test_find_project_root_max_depth():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / ".env.dev").touch()
        deep = root
        for _ in range(6):
            deep = deep / "nested"
        deep.mkdir(parents=True)
        result = find_project_root(deep)
        assert result is None


def test_load_project_env_skip_when_disabled(tmp_project, monkeypatch):
    (tmp_project / ".env.dev").write_text("XIHE_TEST_VAR=from_dotenv\n")
    monkeypatch.setenv("XIHE_LOAD_DOTENV", "0")
    monkeypatch.delenv("XIHE_TEST_VAR", raising=False)
    result = load_project_env()
    assert not result
    assert os.environ.get("XIHE_TEST_VAR") != "from_dotenv"


def test_load_project_env_os_env_snapshot_wins(tmp_project, monkeypatch):
    key = "XIHE_TEST_EXISTING"
    (tmp_project / ".env.dev").write_text(f"{key}=from_dotenv\n")
    monkeypatch.setenv(key, "existing")
    result = load_project_env()
    assert result
    assert os.environ[key] == "existing"


def test_load_project_env_chain_later_file_wins(tmp_project, monkeypatch):
    key = "XIHE_TEST_LAYER"
    (tmp_project / ".env").write_text(f"{key}=from_env\n")
    (tmp_project / ".env.dev").write_text(f"{key}=from_dev\n")
    (tmp_project / ".env.local").write_text(f"{key}=from_local\n")
    monkeypatch.delenv(key, raising=False)
    result = load_project_env()
    assert result
    assert os.environ[key] == "from_local"


def test_load_project_env_selects_profile_by_xihe_env(tmp_project, monkeypatch):
    key = "XIHE_TEST_PROFILE"
    (tmp_project / ".env.dev").write_text(f"{key}=dev\n")
    (tmp_project / ".env.test").write_text(f"{key}=test\n")
    monkeypatch.delenv(key, raising=False)
    assert load_project_env()
    assert os.environ[key] == "dev"

    os.environ.pop(key, None)
    monkeypatch.setenv("XIHE_ENV", "test")
    assert load_project_env()
    assert os.environ[key] == "test"


def test_load_project_env_cli_xihe_env_and_override(tmp_project, monkeypatch):
    key = "XIHE_TEST_CLI"
    (tmp_project / ".env.test").write_text(f"{key}=from_file\n")
    monkeypatch.setenv(key, "from_os")
    assert load_project_env({"XIHE_ENV": "test", key: "from_cli"})
    assert os.environ[key] == "from_cli"
    assert os.environ["XIHE_ENV"] == "test"


def test_load_project_env_interpolation(tmp_project, monkeypatch):
    (tmp_project / ".env").write_text(
        "XIHE_BASE_URL=http://127.0.0.1:12631\n"
        "XIHE_CHILD=${XIHE_BASE_URL}/internal/v1\n"
        "XIHE_FALLBACK=${XIHE_MISSING:-default-value}\n"
    )
    monkeypatch.delenv("XIHE_BASE_URL", raising=False)
    monkeypatch.delenv("XIHE_CHILD", raising=False)
    monkeypatch.delenv("XIHE_FALLBACK", raising=False)
    assert load_project_env()
    assert os.environ["XIHE_CHILD"] == "http://127.0.0.1:12631/internal/v1"
    assert os.environ["XIHE_FALLBACK"] == "default-value"


def test_load_project_env_interpolation_across_files(tmp_project, monkeypatch):
    (tmp_project / ".env").write_text("XIHE_HOST_SEGMENT=127.0.0.1\n")
    (tmp_project / ".env.dev").write_text("XIHE_DERIVED=http://${XIHE_HOST_SEGMENT}:12631\n")
    monkeypatch.delenv("XIHE_HOST_SEGMENT", raising=False)
    monkeypatch.delenv("XIHE_DERIVED", raising=False)
    assert load_project_env()
    assert os.environ["XIHE_DERIVED"] == "http://127.0.0.1:12631"


def test_load_project_env_undefined_interpolation_warns(tmp_project, monkeypatch):
    messages, handler_id = _capture_loguru()
    try:
        (tmp_project / ".env").write_text("XIHE_UNDEFINED_RESULT=${XIHE_NOT_DEFINED_ANYWHERE}\n")
        monkeypatch.delenv("XIHE_UNDEFINED_RESULT", raising=False)
        assert load_project_env()
        assert os.environ["XIHE_UNDEFINED_RESULT"] == ""
        assert any("XIHE_NOT_DEFINED_ANYWHERE" in message for message in messages)
    finally:
        logger.remove(handler_id)


def test_load_project_env_env_file_override(tmp_project, monkeypatch):
    key = "XIHE_TEST_ENV_FILE"
    (tmp_project / ".env.dev").write_text(f"{key}=from_default_chain\n")
    (tmp_project / "custom.env").write_text(f"{key}=from_env_file\n")
    monkeypatch.setenv("XIHE_ENV_FILE", "custom.env")
    monkeypatch.delenv(key, raising=False)
    assert load_project_env()
    assert os.environ[key] == "from_env_file"


def test_load_project_env_missing_file(tmp_project, monkeypatch):
    monkeypatch.delenv("XIHE_LOAD_DOTENV", raising=False)
    result = load_project_env()
    assert not result


def test_parse_cli_overrides():
    assert parse_cli_overrides(["--set", "A=1", "--set=B=x=y", "ignored"]) == {"A": "1", "B": "x=y"}
    assert parse_cli_overrides([]) == {}
    with pytest.raises(ValueError):
        parse_cli_overrides(["--set", "NOEQUALS"])


def test_interpolate_default_and_lookup():
    assert interpolate("${A}", {"A": "1"}) == "1"
    assert interpolate("${MISSING:-fallback}", {}) == "fallback"
    assert interpolate("plain", {}) == "plain"
