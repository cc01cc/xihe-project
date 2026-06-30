import re
from pathlib import Path

import yaml
from loguru import logger

from xihe_agent.registry import WorkerConfig

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)", re.DOTALL)


def parse_markdown_worker(file_path: str | Path) -> WorkerConfig | None:
    path = Path(file_path)
    if path.suffix.lower() != ".md":
        logger.debug("Skipping non-markdown file: %s", path)
        return None

    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        logger.warning("Cannot read worker file %s: %s", path, e)
        return None

    match = _FRONTMATTER_RE.match(text)
    if not match:
        logger.warning("No frontmatter in %s, skipping", path)
        return None

    frontmatter_raw = match.group(1)
    body = match.group(2).strip()

    try:
        fm: dict = yaml.safe_load(frontmatter_raw) or {}
    except yaml.YAMLError as e:
        logger.error("YAML parse error in %s: %s", path, e)
        return None

    worker_id = str(fm.get("id", "")).strip() or path.stem
    name = str(fm.get("name", "")).strip() or worker_id
    description = str(fm.get("description", "")).strip() or f"Agent Worker: {worker_id}"
    enabled = bool(fm.get("enabled", True))
    raw_tool_keys = fm.get("tool_keys")
    tool_keys: list[str] = []
    if isinstance(raw_tool_keys, list):
        tool_keys = [str(k).strip() for k in raw_tool_keys if k]
    elif isinstance(raw_tool_keys, str):
        tool_keys = [raw_tool_keys.strip()]

    if fm.get("id") and fm["id"] != path.stem:
        logger.debug(
            "Worker id '%s' differs from filename '%s' (using id)",
            fm["id"], path.stem,
        )

    return WorkerConfig(
        id=worker_id,
        name=name,
        description=description,
        enabled=enabled,
        system_prompt=body,
        file_path=str(path.resolve()),
        tool_keys=tool_keys,
    )


def scan_workers_dir(workers_dir: str | Path) -> list[WorkerConfig]:
    path = Path(workers_dir)
    if not path.exists():
        logger.info("Workers directory %s does not exist, creating", path)
        path.mkdir(parents=True, exist_ok=True)
        return []

    configs: list[WorkerConfig] = []
    seen_ids: set[str] = set()
    for f in sorted(path.iterdir()):
        if not f.is_file() or f.suffix.lower() != ".md":
            continue
        config = parse_markdown_worker(f)
        if config is None:
            continue
        if config.id in seen_ids:
            logger.warning("Duplicate worker id '%s' from %s, overwriting", config.id, f)
        seen_ids.add(config.id)
        configs.append(config)

    logger.info("Scanned %s, found %d worker(s)", path, len(configs))
    return configs
