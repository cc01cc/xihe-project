from xihe_agent import app_state
from xihe_agent.api import chat


def test_model_catalog_accessor_reads_latest_hot_swap(monkeypatch):
    """Hot swap rebinds app_state._model_catalog; the chat gate must see it.

    A top-level `from app_state import _model_catalog` binds the initial empty
    snapshot and rejects every cross-provider Chat with LLM_MODEL_UNAVAILABLE.
    """
    swapped = {
        "models": {"deepseek": ["fake-deepseek"]},
        "providers": {"deepseek": {"status": "ready", "models": [{"id": "fake-deepseek"}]}},
        "configRevision": "hot-swap",
    }
    monkeypatch.setattr(app_state, "_model_catalog", swapped)

    assert app_state.get_model_catalog() is swapped
    # chat must consume the accessor, never a stale by-value catalog binding.
    assert not hasattr(chat, "_model_catalog")
    info = chat.get_model_catalog().get("providers", {}).get("deepseek")
    assert info is not None
    assert info["status"] == "ready"
