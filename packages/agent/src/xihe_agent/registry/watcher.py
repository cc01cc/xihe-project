import asyncio
import os
from pathlib import Path

from loguru import logger
from watchdog.events import FileCreatedEvent, FileDeletedEvent, FileModifiedEvent, FileSystemEventHandler
from watchdog.observers import Observer

from xihe_agent.registry.loader import parse_markdown_worker

_DEBOUNCE_SECONDS = 0.5


class WorkerFileHandler(FileSystemEventHandler):
    def __init__(self, registry, model, all_mcp_tools, custom_tools):
        self.registry = registry
        self.model = model
        self.all_mcp_tools = all_mcp_tools
        self.custom_tools = custom_tools
        self._debounce_timers: dict[str, asyncio.TimerHandle | None] = {}

    def on_created(self, event: FileCreatedEvent):
        if not event.is_directory and event.src_path.endswith(".md"):
            self._debounce("created", event.src_path, self._handle_created)

    def on_modified(self, event: FileModifiedEvent):
        if not event.is_directory and event.src_path.endswith(".md"):
            self._debounce("modified", event.src_path, self._handle_modified)

    def on_deleted(self, event: FileDeletedEvent):
        if not event.is_directory and event.src_path.endswith(".md"):
            self._debounce("deleted", event.src_path, self._handle_deleted)

    def _debounce(self, event_type: str, path: str, handler):
        path_key = f"{event_type}:{path}"
        existing = self._debounce_timers.get(path_key)
        if existing is not None:
            existing.cancel()

        loop = asyncio.get_event_loop()
        timer = loop.call_later(_DEBOUNCE_SECONDS, lambda: self._execute(handler, path, path_key))
        self._debounce_timers[path_key] = timer

    def _execute(self, handler, path: str, path_key: str):
        self._debounce_timers.pop(path_key, None)
        try:
            handler(path)
        except Exception as e:
            logger.error("File watcher handler failed for %s: %s", path, e, exc_info=True)

    def _handle_created(self, path: str):
        config = parse_markdown_worker(path)
        if config is None:
            return
        logger.info("Watcher: new worker '%s' from %s", config.id, path)
        self.registry.register(config, self.model, self.all_mcp_tools, self.custom_tools)

    def _handle_modified(self, path: str):
        worker_id = _find_worker_id_by_path(self.registry, path)
        if worker_id is None:
            logger.debug("Watcher: modified file not in registry, treating as new: %s", path)
            self._handle_created(path)
            return
        logger.info("Watcher: reloading worker '%s' from %s", worker_id, path)
        self.registry.reload(worker_id, self.model, self.all_mcp_tools, self.custom_tools)

    def _handle_deleted(self, path: str):
        worker_id = _find_worker_id_by_path(self.registry, path)
        if worker_id is None:
            logger.debug("Watcher: deleted file not in registry: %s", path)
            return
        logger.info("Watcher: unregistering worker '%s' (file deleted)", worker_id)
        self.registry.unregister(worker_id)


def _find_worker_id_by_path(registry, file_path: str) -> str | None:
    resolved = str(Path(file_path).resolve())
    for status in registry.list_workers():
        if status.file_path == resolved:
            return status.id
    return None


def start_watcher(registry, model, all_mcp_tools, custom_tools, loop: asyncio.AbstractEventLoop | None = None):
    workers_dir = registry.workers_dir
    if not os.path.isdir(workers_dir):
        logger.warning("Watcher: workers dir '%s' not found, creating", workers_dir)
        os.makedirs(workers_dir, exist_ok=True)

    event_handler = WorkerFileHandler(registry, model, all_mcp_tools, custom_tools)
    observer = Observer()
    observer.schedule(event_handler, workers_dir, recursive=False)
    observer.start()
    logger.info("File watcher started on %s", workers_dir)
    return observer, event_handler
