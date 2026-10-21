"""PLAN-0534: the Agent version comes from installed package metadata."""

from importlib.metadata import PackageNotFoundError, version

import xihe_agent.version as version_module


def test_agent_version_matches_installed_metadata():
    assert version_module.agent_version() == version("xihe-agent")


def test_agent_version_reports_unknown_when_metadata_is_missing(monkeypatch):
    def _missing(_name: str) -> str:
        raise PackageNotFoundError("xihe-agent")

    monkeypatch.setattr(version_module, "version", _missing)
    version_module.agent_version.cache_clear()
    try:
        assert version_module.agent_version() == "unknown"
    finally:
        version_module.agent_version.cache_clear()


def test_build_commit_is_none_when_not_injected(monkeypatch):
    monkeypatch.delenv("XIHE_BUILD_COMMIT", raising=False)
    assert version_module.build_commit() is None


def test_build_commit_rejects_non_sha_values(monkeypatch):
    monkeypatch.setenv("XIHE_BUILD_COMMIT", "not-a-sha")
    assert version_module.build_commit() is None


def test_build_commit_accepts_short_and_full_sha(monkeypatch):
    monkeypatch.setenv("XIHE_BUILD_COMMIT", "b0c68ddf")
    assert version_module.build_commit() == "b0c68ddf"

    monkeypatch.setenv("XIHE_BUILD_COMMIT", "b0c68ddf5e280862e12d2734692ab40802be1a6f")
    assert version_module.build_commit() == "b0c68ddf5e280862e12d2734692ab40802be1a6f"
