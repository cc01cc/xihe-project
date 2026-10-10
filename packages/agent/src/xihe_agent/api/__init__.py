"""Agent HTTP API modules.

PLAN-0473 M1 (spec/agent-module-boundaries.md): HTTP routes, request parsing,
and route-level error mapping moved out of `main.py`, grouped by domain.
Each module builds an `APIRouter`; `main.py` includes them all. Runtime
singletons and shared helpers come from `xihe_agent.app_state`.
"""
