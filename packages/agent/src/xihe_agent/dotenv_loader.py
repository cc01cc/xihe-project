"""Module-local env chain loader (PLAN-0307 T3.1/T3.5; spec/config-env-target §1.2/§1.5).

Single-authority loader for the Agent module: CLI ``--set`` > process env snapshot >
file chain (``.env`` → ``.env.$XIHE_ENV`` → ``.env.local``) > code default.
``scripts/run-with-log.sh`` no longer sources env files; every module loads its own chain.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from dotenv import dotenv_values
from loguru import logger

MAX_DEPTH = 5
BOOTSTRAP_ENV_KEY = "XIHE_ENV"
LOAD_DOTENV_KEY = "XIHE_LOAD_DOTENV"
ENV_FILE_KEY = "XIHE_ENV_FILE"
_ROOT_MARKERS = (".env", ".env.dev", ".env.test", ".env.prod", ".env.example")

_INTERPOLATION_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")

# §1.5: undefined interpolation escalates from WARNING to ERROR for fail-fast keys.
_CRITICAL_KEYS = frozenset(
    {
        "XIHE_CP_JWT_SECRET",
        "XIHE_CP_API_TOKEN",
        "XIHE_AGENT_API_TOKEN",
        "XIHE_CP_OAUTH_ENCRYPTION_KEY",
        "XIHE_CP_PROVIDER_CREDENTIALS_KEY",
    }
)


def find_project_root(start: Path | None = None, max_depth: int = MAX_DEPTH) -> Path | None:
    cwd = (start or Path.cwd()).resolve()
    for _ in range(max_depth):
        if any((cwd / marker).exists() for marker in _ROOT_MARKERS):
            return cwd
        if (cwd / ".git").exists():
            return None
        parent = cwd.parent
        if parent == cwd:
            return None
        cwd = parent
    return None


def parse_cli_overrides(argv: list[str]) -> dict[str, str]:
    """Parse ``--set KEY=VALUE`` / ``--set=KEY=VALUE`` pairs (values may contain '=')."""
    overrides: dict[str, str] = {}
    index = 0
    while index < len(argv):
        token = argv[index]
        pair: str | None = None
        if token == "--set" and index + 1 < len(argv):
            pair = argv[index + 1]
            index += 2
        elif token.startswith("--set="):
            pair = token[len("--set=") :]
            index += 1
        else:
            index += 1
        if pair is None:
            continue
        if "=" not in pair:
            raise ValueError(f"--set expects KEY=VALUE, got: {pair}")
        key, value = pair.split("=", 1)
        overrides[key.strip()] = value
    return overrides


def interpolate(value: str, lookup: dict[str, str]) -> str:
    """Resolve ``${VAR}`` / ``${VAR:-default}``; undefined without default → WARN + empty."""

    def replace(match: re.Match[str]) -> str:
        name, default = match.group(1), match.group(2)
        if name in lookup:
            return lookup[name]
        if default is not None:
            return default
        level = "ERROR" if name in _CRITICAL_KEYS else "WARNING"
        logger.log(
            level,
            "Undefined variable in env interpolation: ${{{}}} (resolved to empty string)",
            name,
        )
        return ""

    return _INTERPOLATION_RE.sub(replace, value)


def _apply_cli_overrides(overrides: dict[str, str]) -> None:
    # §1.2 step 5: CLI overrides win over everything; values are always masked in logs.
    for key in overrides:
        logger.info("CLI override: {}=***", key)
    for key, value in overrides.items():
        os.environ[key] = value


def _resolve_env_file(root: Path, value: str) -> Path:
    candidate = Path(value)
    return candidate if candidate.is_absolute() else root / candidate


def load_project_env(cli_overrides: dict[str, str] | None = None) -> bool:
    """Apply the env chain. Returns True when at least one env file was loaded."""
    overrides = dict(cli_overrides or {})

    if os.getenv(LOAD_DOTENV_KEY) == "0":
        _apply_cli_overrides(overrides)
        return False

    root = find_project_root()
    if root is None:
        _apply_cli_overrides(overrides)
        return False

    env_name = overrides.get(BOOTSTRAP_ENV_KEY) or os.getenv(BOOTSTRAP_ENV_KEY) or "dev"
    snapshot = dict(os.environ)
    lookup: dict[str, str] = dict(snapshot)

    env_file = overrides.get(ENV_FILE_KEY) or os.getenv(ENV_FILE_KEY)
    files = (
        [_resolve_env_file(root, env_file)]
        if env_file
        else [root / ".env", root / f".env.{env_name}", root / ".env.local"]
    )

    merged: dict[str, str] = {}
    sources: dict[str, str] = {}
    loaded_any = False
    for path in files:
        if not path.exists():
            continue
        loaded_any = True
        values = dotenv_values(path, interpolate=False, encoding="utf-8")
        for key, raw in values.items():
            if raw is None:
                continue
            merged[key] = interpolate(raw, lookup)
            lookup[key] = merged[key]
            sources[key] = path.name

    # §1.2 step 4: later file wins inside the chain, but never over the OS env snapshot.
    for key, value in merged.items():
        if key not in snapshot:
            os.environ[key] = value
            # §7 transparency: per-key source layer (values masked).
            logger.debug("Env loaded: {}=*** (source={})", key, sources[key])
    if loaded_any:
        logger.debug("Env chain files: {}", [str(path) for path in files if path.exists()])
    _apply_cli_overrides(overrides)
    return loaded_any
