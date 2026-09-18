"""PLAN-0342 M1 unit tests: L0/L2 extraction, ledger, sorting and budgets."""

import json

import xihe_agent.context.diagnostics as diagnostics_module
from xihe_agent.context.diagnostics import (
    TOP_N,
    Diagnostic,
    DiagnosticsLedger,
    extract_command_result,
    extract_diagnostics,
    format_diagnostics_block,
    identity_key,
    make_bundle,
    sort_diagnostics,
    truncate_message,
    truncate_middle,
)


def _diag(
    file: str | None = "src/a.rs",
    line: int | None = 1,
    column: int | None = None,
    severity: str = "error",
    kind: str | None = None,
    message: str = "boom",
    confidence: str = "high",
) -> Diagnostic:
    return Diagnostic(
        file=file,
        line=line,
        column=column,
        severity=severity,  # type: ignore[arg-type]
        kind=kind,  # type: ignore[arg-type]
        message=message,
        confidence=confidence,  # type: ignore[arg-type]
    )


# ── L0 命中与锚定（T0.4 冻结样本集） ─────────────────────────────────────────


def test_l0_hit_with_column_and_kind_from_command():
    items = extract_diagnostics("src/main.rs:12:5: error: mismatched types", "", 1, command="cargo build")

    assert len(items) == 1
    item = items[0]
    assert item.file == "src/main.rs"
    assert item.line == 12
    assert item.column == 5
    assert item.severity == "error"
    assert item.kind == "compile"
    assert item.message == "error: mismatched types"
    assert item.confidence == "high"


def test_l0_hit_without_column():
    items = extract_diagnostics("tests/test_a.py:7: FAILED (assertion)", "", 1)

    assert len(items) == 1
    assert items[0].file == "tests/test_a.py"
    assert items[0].line == 7
    assert items[0].column is None
    assert items[0].severity == "error"
    assert items[0].kind is None


def test_l0_backslash_path_is_normalized():
    items = extract_diagnostics("src\\main.rs:3:1: error: bad", "", 1)

    assert [item.file for item in items] == ["src/main.rs"]


def test_l0_rejects_timestamps_urls_and_non_path_shapes():
    lines = [
        "12:34:56 ERROR boom",
        "2026-09-18 12:34:56: something",
        "1:2:3",
        "https://example.dev:443/path:1:2",
        "lib\\a.ts(3,1): error TS2322",
        "exit code 1",
    ]
    for line in lines:
        assert extract_diagnostics(line, "", 1) == [], line


def test_l0_scans_stdout_and_stderr():
    items = extract_diagnostics(
        "src/a.rs:1:1: error: from stdout",
        "src/b.rs:2:2: warning: from stderr",
        1,
        command="cargo build",
    )

    assert {(item.file, item.line, item.column) for item in items} == {
        ("src/a.rs", 1, 1),
        ("src/b.rs", 2, 2),
    }
    assert [item.severity for item in items] == ["error", "warning"]


def test_severity_mapping_defaults_to_error():
    stdout = "\n".join(
        [
            "a.rs:1:1: warning: unused variable",
            "a.rs:2:1: WARN: nearly",
            "a.rs:3:1: note: informational",
            "a.rs:4:1: something broke",
            "a.rs:5:1: error[E0308]: mismatched types",
        ]
    )
    items = extract_diagnostics(stdout, "", 1)

    assert {item.line: item.severity for item in items} == {
        1: "warning",
        2: "warning",
        3: "note",
        4: "error",
        5: "error",
    }


def test_kind_mapping_is_conservative():
    line = "src/a.rs:1:1: boom"
    cases = {
        "uv run pytest -q": "test",
        "npm run build": "compile",
        "cargo test --lib": "test",
        "ruff check src": "lint",
        "make all": "runtime",
    }
    for command, expected in cases.items():
        items = extract_diagnostics(line, "", 1, command=command)
        assert [item.kind for item in items] == [expected], command
    assert extract_diagnostics(line, "", 1, command=None)[0].kind is None
    assert extract_diagnostics(line, "", 1, command="  ")[0].kind is None


# ── L2 退化 ─────────────────────────────────────────────────────────────────


def test_l2_degrades_to_empty_without_guessing():
    assert extract_diagnostics("no structured diagnostics here\njust prose", "", 1) == []
    bundle = make_bundle([], 0, "low")
    assert bundle == {"items": [], "total": 0, "confidence": "low"}


def test_zero_exit_never_produces_diagnostics():
    assert extract_diagnostics("src/a.rs:1:1: error: boom", "", 0) == []


# ── extract_command_result ──────────────────────────────────────────────────


def test_extract_command_result_top_level_and_camel_case():
    body = json.dumps({"exit_code": 1, "stdout": "out", "stderr": "err"})
    assert extract_command_result(body) == ("out", "err", 1)

    camel = json.dumps({"exitCode": 2, "stdout": "x"})
    assert extract_command_result(camel) == ("x", "", 2)


def test_extract_command_result_nested_envelopes():
    nested = json.dumps({"ok": True, "result": {"exit_code": 1, "stdout": "o", "stderr": "e"}})
    assert extract_command_result(nested) == ("o", "e", 1)

    data = json.dumps({"data": {"exitCode": 0, "stdout": "fine"}})
    assert extract_command_result(data) == ("fine", "", 0)

    tool_result = json.dumps({"tool_result": {"result": {"exit_code": 3, "stderr": "bad"}}})
    assert extract_command_result(tool_result) == ("", "bad", 3)


def test_extract_command_result_rejects_non_command_content():
    assert extract_command_result("") is None
    assert extract_command_result("plain tool output") is None
    assert extract_command_result(json.dumps({"content": "hi"})) is None
    assert extract_command_result(json.dumps({"exit_code": None})) is None
    assert extract_command_result(json.dumps({"exit_code": "not-a-number"})) is None
    assert extract_command_result(json.dumps([1, 2, 3])) is None


# ── 去重账本（连续重复抑制） ────────────────────────────────────────────────


def test_ledger_suppresses_consecutive_duplicates():
    ledger = DiagnosticsLedger()
    first_item = _diag(file="a.rs", line=1)
    second_item = _diag(file="b.rs", line=2)

    assert ledger.new_items("s1", [first_item]) == [first_item]
    assert ledger.new_items("s1", [first_item]) == []
    assert ledger.new_items("s1", [first_item, second_item]) == [second_item]
    assert ledger.new_items("s1", [first_item, second_item]) == []


def test_ledger_regression_after_disappearance_is_new_again():
    ledger = DiagnosticsLedger()
    first_item = _diag(file="a.rs", line=1)
    other_item = _diag(file="b.rs", line=2)

    assert ledger.new_items("s1", [first_item]) == [first_item]
    # 中间消失（换成别的诊断）后再出现 = 回归，照常回灌。
    assert ledger.new_items("s1", [other_item]) == [other_item]
    assert ledger.new_items("s1", [first_item]) == [first_item]
    # 空观察同样构成"消失"。
    assert ledger.new_items("s1", []) == []
    assert ledger.new_items("s1", [first_item]) == [first_item]


def test_ledger_is_isolated_by_session_and_resettable():
    ledger = DiagnosticsLedger()
    item = _diag(file="a.rs", line=1)

    assert ledger.new_items("s1", [item]) == [item]
    assert ledger.new_items("s2", [item]) == [item]

    ledger.reset("s1")
    assert ledger.new_items("s1", [item]) == [item]
    assert ledger.new_items("s2", [item]) == []

    ledger.reset()
    assert ledger.new_items("s1", [item]) == [item]
    assert ledger.new_items("s2", [item]) == [item]


def test_ledger_evicts_oldest_session_beyond_cap(monkeypatch):
    """round-15 P2-4: the process-level ledger is bounded (oldest evicted)."""
    monkeypatch.setattr(diagnostics_module, "_MAX_SESSIONS", 2)
    ledger = DiagnosticsLedger()
    item = _diag(file="a.rs", line=1)

    assert ledger.new_items("s1", [item]) == [item]
    assert ledger.new_items("s2", [item]) == [item]
    # s3 exceeds the cap → oldest (s1) is evicted and re-injects next time.
    assert ledger.new_items("s3", [item]) == [item]
    assert ledger.new_items("s1", [item]) == [item]
    # s3 stayed tracked throughout the whole sequence.
    assert ledger.new_items("s3", [item]) == []
    # s2 became the oldest when s1 came back and was evicted in turn.
    assert ledger.new_items("s2", [item]) == [item]


def test_identity_key_uses_dash_for_missing_parts():
    assert identity_key(_diag(file=None, line=None, column=None)) == ("-", "-", "-")
    assert identity_key(_diag(file="a.rs", line=3, column=None)) == ("a.rs", "3", "-")


# ── 排序、Top-N 与截断 ──────────────────────────────────────────────────────


def test_sort_order_is_severity_then_file_then_line():
    items = [
        _diag(file="b.rs", line=1, severity="error"),
        _diag(file="a.rs", line=9, severity="note"),
        _diag(file="a.rs", line=2, severity="error"),
        _diag(file="a.rs", line=1, severity="warning"),
        _diag(file="a.rs", line=1, severity="error"),
    ]

    ordered = sort_diagnostics(items)

    assert [(item.severity, item.file, item.line) for item in ordered] == [
        ("error", "a.rs", 1),
        ("error", "a.rs", 2),
        ("error", "b.rs", 1),
        ("warning", "a.rs", 1),
        ("note", "a.rs", 9),
    ]


def test_make_bundle_caps_items_at_top_n_and_block_counts_remainder():
    items = [_diag(file=f"src/f{i}.rs", line=i, severity="error") for i in range(1, TOP_N + 6)]

    bundle = make_bundle(items, len(items), "high")
    assert len(bundle["items"]) == TOP_N
    assert bundle["total"] == TOP_N + 5
    assert set(bundle["items"][0]) == {
        "file",
        "line",
        "column",
        "severity",
        "kind",
        "message",
        "confidence",
    }

    block = format_diagnostics_block(items[:TOP_N], len(items))
    assert block.startswith("<diagnostics>\n")
    assert block.endswith("\n</diagnostics>")
    assert block.count("\n- ") == TOP_N
    assert "(另有 5 条)" in block


def test_format_diagnostics_block_omits_remainder_when_all_shown():
    items = [_diag(file="a.rs", line=1), _diag(file="b.rs", line=2)]
    block = format_diagnostics_block(items, 2)

    assert "另有" not in block
    assert "- a.rs:1 [error] boom" in block
    assert "- b.rs:2 [error] boom" in block


def test_truncate_message_marks_dropped_characters():
    text = "x" * 1500
    truncated = truncate_message(text)

    assert truncated.startswith("x" * 1000)
    assert "[已截断 500 字符]" in truncated
    assert truncate_message("short") == "short"


def test_extract_diagnostics_truncates_long_messages():
    message = "error: " + "y" * 1500
    items = extract_diagnostics(f"src/a.rs:1:1: {message}", "", 1)

    assert len(items) == 1
    assert "[已截断" in items[0].message
    assert len(items[0].message) < len(message)


def test_truncate_middle_keeps_head_and_tail():
    text = "".join(chr(ord("a") + (i % 26)) for i in range(100_000))
    truncated = truncate_middle(text)

    assert truncated.startswith(text[:24_000])
    assert truncated.endswith(text[-24_000:])
    assert f"[中段已截断 {100_000 - 48_000} 字符]" in truncated
    assert len(truncated) < 100_000


def test_truncate_middle_leaves_small_text_untouched():
    assert truncate_middle("short output") == "short output"


def test_l0_bounds_line_and_column_digits():
    """Review fix: overlong numeric segments must not hit Python's int() limit."""
    huge = "9" * 5000

    assert extract_diagnostics("", f"src/a.rs:{huge}: boom", 1) == []
    col_items = extract_diagnostics("", f"src/a.rs:1:{huge}: boom", 1)
    assert col_items and col_items[0].line == 1
    assert col_items[0].column is None
    assert extract_diagnostics("", "src/a.rs:123456789: boom", 1)[0].line == 123456789
