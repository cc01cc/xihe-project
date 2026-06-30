import tempfile
from pathlib import Path

from xihe_agent.registry.loader import parse_markdown_worker, scan_workers_dir


def _write_md(path: Path, content: str):
    path.write_text(content, encoding="utf-8")


def test_parse_valid_worker():
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "research.md"
        _write_md(f, """\
---
id: research
name: 研究助手
enabled: true
description: 用于网页搜索
---

You are a research assistant.
""")
        config = parse_markdown_worker(f)
        assert config is not None
        assert config.id == "research"
        assert config.name == "研究助手"
        assert config.enabled is True
        assert config.description == "用于网页搜索"
        assert config.system_prompt == "You are a research assistant."
        assert config.file_path == str(f.resolve())


def test_parse_no_frontmatter():
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "plain.md"
        _write_md(f, "Just some text\nno frontmatter here")
        config = parse_markdown_worker(f)
        assert config is None


def test_parse_missing_id_fallback_to_filename():
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "my-worker.md"
        _write_md(f, """\
---
name: My Worker
---

Hello
""")
        config = parse_markdown_worker(f)
        assert config is not None
        assert config.id == "my-worker"


def test_parse_missing_name_fallback_to_id():
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "test.md"
        _write_md(f, """\
---
id: test
---

Body
""")
        config = parse_markdown_worker(f)
        assert config is not None
        assert config.name == "test"


def test_parse_missing_description_fallback():
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "x.md"
        _write_md(f, """\
---
id: x
---

Body
""")
        config = parse_markdown_worker(f)
        assert config is not None
        assert config.description == "Agent Worker: x"


def test_parse_enabled_defaults_true():
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "a.md"
        _write_md(f, """\
---
id: a
---

Body
""")
        config = parse_markdown_worker(f)
        assert config is not None
        assert config.enabled is True


def test_parse_explicit_enabled_false():
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "b.md"
        _write_md(f, """\
---
id: b
enabled: false
---

Body
""")
        config = parse_markdown_worker(f)
        assert config is not None
        assert config.enabled is False


def test_parse_tool_keys_list():
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "c.md"
        _write_md(f, """\
---
id: c
tool_keys:
  - web_fetch
  - extract_pdf
---

Body
""")
        config = parse_markdown_worker(f)
        assert config is not None
        assert config.tool_keys == ["web_fetch", "extract_pdf"]


def test_parse_tool_keys_string():
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "d.md"
        _write_md(f, """\
---
id: d
tool_keys: web_fetch
---

Body
""")
        config = parse_markdown_worker(f)
        assert config is not None
        assert config.tool_keys == ["web_fetch"]


def test_parse_yaml_syntax_error():
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "bad.md"
        _write_md(f, """\
---
id: bad
name: {{bad}}
---

Body
""")
        config = parse_markdown_worker(f)
        assert config is None


def test_parse_non_md_file():
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "notes.txt"
        _write_md(f, "not markdown")
        config = parse_markdown_worker(f)
        assert config is None


def test_scan_workers_dir_creates_dir():
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp) / "nonexistent"
        configs = scan_workers_dir(d)
        assert configs == []
        assert d.exists()


def test_scan_workers_dir_skips_non_md():
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "readme.txt").write_text("not a worker")
        (Path(tmp) / "worker.md").write_text("""\
---
id: w1
---

Hello
""")
        configs = scan_workers_dir(tmp)
        assert len(configs) == 1
        assert configs[0].id == "w1"


def test_scan_workers_dir_duplicate_id():
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "a.md").write_text("""\
---
id: dup
---

A
""")
        (Path(tmp) / "b.md").write_text("""\
---
id: dup
---

B
""")
        configs = scan_workers_dir(tmp)
        assert len(configs) == 2
        dup_ids = [c.id for c in configs]
        assert dup_ids.count("dup") == 2
