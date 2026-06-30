import os
from pathlib import Path

from dotenv import load_dotenv


def find_project_root(start: Path | None = None, max_depth: int = 5) -> Path | None:
    cwd = start or Path.cwd().resolve()
    for _ in range(max_depth):
        if (cwd / ".env.dev").exists():
            return cwd
        if (cwd / ".git").exists():
            return None
        parent = cwd.parent
        if parent == cwd:
            return None
        cwd = parent
    return None


def load_project_env(override: bool = False) -> bool:
    if os.getenv("XIHE_LOAD_DOTENV") == "0":
        return False
    root = find_project_root()
    if root is None:
        return False
    base = root / ".env"
    if base.exists():
        load_dotenv(base, override=override)
    dev = root / ".env.dev"
    if dev.exists():
        load_dotenv(dev, override=override)
    return True
