"""BL-361: guard the default pytest collection surface.

`packages/agent/pyproject.toml` deselects the `integration` marker by default, so an
integration test that forgets `pytestmark = [pytest.mark.integration]` would silently run
(and hard-fail on missing XIHE_E2E_PG_*) or silently escape the host lane. This meta test
turns that omission into an explicit failure.

Whitelist policy (Lead ruling, 2026-11-06): a few files live under `tests/integration/`
but do not need any environment and are worth running in the default gate. The allowlist
may only shrink — a new file must carry the marker; adding a whitelist entry is not a way
to pass this test.
"""

from pathlib import Path

INTEGRATION_DIR = Path(__file__).resolve().parents[1] / "integration"

# Directory convention says integration, but these need no PG env and stay in the default
# gate (they passed there before BL-361). Do not grow this set; the anti-abuse check below
# fails if a listed file gains the marker (stale whitelist) or stops existing.
ENV_FREE_INTEGRATION = {
    "test_mcp_real_server_fixture.py",
    "test_registry_integration.py",
}


def test_every_integration_test_declares_the_integration_marker() -> None:
    assert INTEGRATION_DIR.is_dir(), f"missing directory: {INTEGRATION_DIR}"
    missing: list[str] = []
    for path in sorted(INTEGRATION_DIR.rglob("test_*.py")):
        if path.name in ENV_FREE_INTEGRATION:
            continue
        text = path.read_text(encoding="utf-8")
        if "pytestmark" not in text or "pytest.mark.integration" not in text:
            missing.append(str(path.relative_to(INTEGRATION_DIR)))
    assert not missing, (
        "tests/integration files must declare pytestmark = [pytest.mark.integration] "
        f"(BL-361); env-free allowlist may only shrink: {missing}"
    )


def test_env_free_allowlist_stays_honest() -> None:
    for name in sorted(ENV_FREE_INTEGRATION):
        path = INTEGRATION_DIR / name
        assert path.is_file(), f"allowlisted file no longer exists (remove it from the list): {name}"
        text = path.read_text(encoding="utf-8")
        assert "pytestmark = [pytest.mark.integration]" not in text, (
            f"{name} now declares the integration marker; remove it from ENV_FREE_INTEGRATION "
            "(the allowlist is not allowed to grow or go stale)"
        )
