"""Tests for registry/watcher.py - file monitoring with watchdog."""
from unittest.mock import MagicMock, patch

import pytest

from xihe_agent.registry.watcher import WorkerFileHandler


@pytest.fixture
def handler():
    registry = MagicMock()
    model = MagicMock()
    return WorkerFileHandler(registry, model, [], [])


class TestWorkerFileHandler:
    def test_on_created_ignores_directories(self, handler):
        event = MagicMock()
        event.is_directory = True
        event.src_path = "/path/to/dir"
        handler.on_created(event)
        assert len(handler._debounce_timers) == 0

    def test_on_created_ignores_non_md(self, handler):
        event = MagicMock()
        event.is_directory = False
        event.src_path = "/path/to/file.txt"
        handler.on_created(event)
        assert len(handler._debounce_timers) == 0

    def test_on_created_processes_md(self, handler):
        event = MagicMock()
        event.is_directory = False
        event.src_path = "/path/to/file.md"
        with patch.object(handler, "_debounce") as mock_deb:
            handler.on_created(event)
        mock_deb.assert_called_once()

    def test_on_modified_processes_md(self, handler):
        event = MagicMock()
        event.is_directory = False
        event.src_path = "/path/to/file.md"
        with patch.object(handler, "_debounce") as mock_deb:
            handler.on_modified(event)
        mock_deb.assert_called_once()

    def test_on_deleted_processes_md(self, handler):
        event = MagicMock()
        event.is_directory = False
        event.src_path = "/path/to/file.md"
        with patch.object(handler, "_debounce") as mock_deb:
            handler.on_deleted(event)
        mock_deb.assert_called_once()
