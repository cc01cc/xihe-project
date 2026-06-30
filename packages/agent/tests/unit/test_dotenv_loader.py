import os
import tempfile
from pathlib import Path

from xihe_agent.dotenv_loader import find_project_root, load_project_env


def test_find_project_root_found():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / ".env.dev").touch()
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


def test_load_project_env_skip_when_disabled():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / ".env.dev").write_text("XIHE_TEST_VAR=from_dotenv\n")
        old = os.environ.get("XIHE_LOAD_DOTENV")
        os.environ["XIHE_LOAD_DOTENV"] = "0"
        try:
            result = load_project_env()
            assert not result
            assert os.environ.get("XIHE_TEST_VAR") != "from_dotenv"
        finally:
            if old is None:
                os.environ.pop("XIHE_LOAD_DOTENV", None)
            else:
                os.environ["XIHE_LOAD_DOTENV"] = old


def test_load_project_env_override_false(monkeypatch):
    key = "XIHE_TEST_EXISTING"
    old = os.environ.get(key)
    os.environ[key] = "existing"
    try:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".env.dev").write_text(f"{key}=from_dotenv\n")
            monkeypatch.chdir(root)
            result = load_project_env()
            assert result
            assert os.environ[key] == "existing"
    finally:
        if old is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = old


def test_load_project_env_honors_override_true(monkeypatch):
    key = "XIHE_TEST_OVERRIDE"
    old = os.environ.get(key)
    os.environ[key] = "existing"
    try:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".env.dev").write_text(f"{key}=from_dotenv\n")
            monkeypatch.chdir(root)
            result = load_project_env(override=True)
            assert result
            assert os.environ[key] == "from_dotenv"
    finally:
        if old is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = old


def test_load_project_env_missing_file(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        monkeypatch.chdir(root)
        result = load_project_env()
        assert not result


def test_load_project_env_env_then_dev(monkeypatch):
    key = "XIHE_TEST_LAYER"
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / ".env").write_text(f"{key}=from_env\n")
        (root / ".env.dev").write_text(f"{key}=from_dev\n")
        monkeypatch.chdir(root)
        result = load_project_env()
        assert result
        assert os.environ[key] == "from_env"
