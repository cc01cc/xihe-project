"""Entry-time `NO_PROXY` normalization (PLAN-0539).

Bootstrap code. Imported from :mod:`xihe_agent.__init__` so it runs before any
other ``xihe_agent`` submodule exists — that timing is the whole point:

* ``main.py`` imports :mod:`xihe_agent.app_state` first, and ``app_state``
  constructs the CP context/event-store clients at module scope
  (``app_state.py:169-170``);
* ``httpx`` parses every ``NO_PROXY`` entry into a ``URLPattern`` while the
  client is being *constructed* when ``trust_env`` is enabled (the default), so
  a bracketed IPv6 entry such as ``[::1]`` aborts client construction with
  ``httpx.InvalidURL: Invalid port: ':1]'``;
* some hosts (observed: DeepSeek Harness) inject that entry into every child
  process, and repairing the value from a parent shell does not reach the Python
  child. So the value has to be repaired *inside* this process, before the first
  client is built.

Only bracketed entries are dropped. The bare ``::1`` form parses correctly and is
kept, otherwise the IPv6 loopback would silently fall back to the proxy. Nothing
else is touched: outbound proxies and every other entry stay as they are, so
provider traffic keeps using the proxy it was configured with.

The alternative — putting this in ``dotenv_loader.load_project_env()`` (or in
``main()``/the ``__main__`` block/lifespan) — was rejected: every one of those
runs after ``app_state`` has already been imported, so the crash happens first.
"""

from __future__ import annotations

import os
from collections.abc import MutableMapping

PROXY_KEYS: tuple[str, ...] = ("NO_PROXY", "no_proxy")


def sanitize_no_proxy_value(value: str) -> str:
    """Drop bracketed entries from one `NO_PROXY`-style value.

    Empty entries produced by stray commas are dropped as well; the caller
    decides what an empty result means.
    """
    entries = (entry.strip() for entry in value.split(","))
    return ",".join(entry for entry in entries if entry and "[" not in entry and "]" not in entry)


def sanitize_no_proxy_env(environ: MutableMapping[str, str] | None = None) -> dict[str, str | None]:
    """Repair `NO_PROXY`/`no_proxy` in place and report what changed.

    Returns ``{key: new_value_or_None}`` for keys that were rewritten (``None``
    means the key was removed). An empty result removes the variable on purpose:
    an empty ``NO_PROXY`` and an unset ``NO_PROXY`` mean different things to
    httpx — the latter falls back to its default bypass list.
    """
    env = os.environ if environ is None else environ
    changes: dict[str, str | None] = {}

    for key in PROXY_KEYS:
        raw = env.get(key)
        if raw is None:
            continue
        cleaned = sanitize_no_proxy_value(raw)
        if cleaned == raw:
            continue
        if cleaned:
            env[key] = cleaned
            changes[key] = cleaned
        else:
            del env[key]
            changes[key] = None

    return changes
