"""BL-361: guard the default pytest collection surface.

`packages/agent/pyproject.toml` deselects the `integration` marker by default, so an
integration test that forgets `pytestmark = [pytest.mark.integration]` would silently run
(and hard-fail on missing XIHE_E2E_PG_*) or silently escape the host lane. This meta test
turns that omission into an explicit failure.
"""

from pathlib import Path

INTEGRATION_DIR = Path(__file__).resolve().parents[1] / "integration"


def test_every_integration_test_declares_the_integration_marker() -> None:
    assert INTEGRATION_DIR.is_dir(), f"missing directory: {INTEGRATION_DIR}"
    missing: list[str] = []
    for path in sorted(INTEGRATION_DIR.rglob("test_*.py")):
        text = path.read_text(encoding="utf-8")
        if "pytestmark" not in text or "pytest.mark.integration" not in text:
            missing.append(str(path.relative_to(INTEGRATION_DIR)))
    assert not missing, (
        "tests/integration files must declare pytestmark = [pytest.mark.integration] "
        f"(BL-361): {missing}"
    )
