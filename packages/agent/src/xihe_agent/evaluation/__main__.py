"""CLI for the offline evaluation suite (PLAN-0511/0540).

`validate`, `run` (one lane per invocation), `compare` and `gate`.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from xihe_agent.evaluation import DATASET_VERSION, dataset_sha256, load_dataset
from xihe_agent.evaluation.compare import compare_reports
from xihe_agent.evaluation.report import EvalReport, EvalReportV2
from xihe_agent.evaluation.schema import EvalTaskV2


def _cmd_validate(args: argparse.Namespace) -> int:
    dataset_path = Path(args.dataset) if args.dataset else None
    tasks = load_dataset(dataset_path)
    print(f"dataset={DATASET_VERSION} tasks={len(tasks)} sha256={dataset_sha256(dataset_path)}")
    for task in tasks:
        extra = ""
        if isinstance(task, EvalTaskV2):
            extra = f" class={task.assertion_class} attempts={task.attempts}"
        print(f"  {task.task_id} [{task.category}]{extra} assertions={len(task.hard_assertions)}")
    return 0


def _load_report(path: str) -> EvalReport | EvalReportV2:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    version = data.get("schema_version") if isinstance(data, dict) else None
    if version == 1:
        return EvalReport.model_validate(data)
    if version == 2:
        return EvalReportV2.model_validate(data)
    raise ValueError(f"unsupported report schema_version={version!r}: {path}")


def _cmd_compare(args: argparse.Namespace) -> int:
    baseline = _load_report(args.baseline)
    candidate = _load_report(args.candidate)
    diff = compare_reports(baseline, candidate)
    print(json.dumps(diff.model_dump(), indent=2, sort_keys=True))
    return 0


def _cmd_run(args: argparse.Namespace) -> int:
    import os

    from xihe_agent.evaluation.cp_http import HttpCpClient
    from xihe_agent.evaluation.loader import dataset_sha256
    from xihe_agent.evaluation.runner import run_dataset_v2
    from xihe_agent.evaluation.schema import EvalTaskV2

    base_url = args.cp_url or os.environ.get("XIHE_EVAL_CP_URL", "http://127.0.0.1:12631")
    token = args.token or os.environ.get("XIHE_EVAL_TOKEN")
    if not token:
        print("run requires a Bearer token (--token or XIHE_EVAL_TOKEN)", file=sys.stderr)
        return 2
    provider = args.provider or os.environ.get("XIHE_EVAL_PROVIDER")
    model = args.model or os.environ.get("XIHE_EVAL_MODEL")
    agent_principal_id = args.agent_principal or os.environ.get("XIHE_EVAL_AGENT_PRINCIPAL")
    only = {t for t in (args.only or os.environ.get("XIHE_EVAL_ONLY", "")).split(",") if t}
    timeout_s = float(args.timeout or os.environ.get("XIHE_EVAL_TIMEOUT", "180"))
    tool_surface = bool(args.tool_surface) or os.environ.get("XIHE_EVAL_TOOL_SURFACE") == "1"

    dataset_path = Path(args.dataset) if args.dataset else None
    all_tasks = [t for t in load_dataset(dataset_path) if not only or t.task_id in only]
    tasks: list[EvalTaskV2] = []
    for task in all_tasks:
        if isinstance(task, EvalTaskV2) and task.assertion_class == args.lane:
            tasks.append(task)
    if not tasks:
        print(f"no tasks selected for lane {args.lane!r}", file=sys.stderr)
        return 2

    eval_run_id = args.output_dir or f".local/evaluation/{int(time.time())}"
    raw_dir = Path(eval_run_id) / "raw"
    commit = _git_commit()
    client = HttpCpClient(
        base_url,
        token,
        provider=provider,
        model=model,
        agent_principal_id=agent_principal_id,
        raw_dir=raw_dir,
    )
    try:
        report = run_dataset_v2(
            client,
            tasks,
            lane=args.lane,
            eval_run_id=Path(eval_run_id).name,
            commit=commit,
            dataset_version=DATASET_VERSION,
            dataset_hash=dataset_sha256(dataset_path),
            min_valid_attempts=args.min_valid_attempts,
            attempts_override=args.attempts,
            provider=provider,
            model=model,
            timeout_s=timeout_s,
            tool_surface_enabled=tool_surface,
        )
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    finally:
        client.close()
    out = Path(eval_run_id)
    out.mkdir(parents=True, exist_ok=True)
    report_path = out / "report.json"
    report_path.write_text(json.dumps(report.model_dump(), indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {report_path}")
    print(json.dumps(report.aggregate, ensure_ascii=False))
    return 0


def _gate_schema_version(path: Path) -> int | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    version = data.get("schema_version") if isinstance(data, dict) else None
    return version if isinstance(version, int) else None


def _cmd_gate(args: argparse.Namespace) -> int:
    from datetime import UTC, datetime

    from xihe_agent.evaluation.gate import (
        EXIT_CODES,
        STATE_GATE_ERROR,
        GateResult,
        evaluate_gate,
    )
    from xihe_agent.evaluation.gate_v2 import evaluate_gate_v2

    config_path = Path(args.config or "evaluation/gate-v2.json")
    report_paths = [Path(path) for path in args.report]
    baseline_path = Path(args.baseline) if args.baseline else None
    if _gate_schema_version(config_path) == 2:
        result_v2 = evaluate_gate_v2(
            report_paths=report_paths,
            baseline_path=baseline_path,
            config_path=config_path,
            target_commit=args.target_commit,
        )
        print(
            json.dumps(
                result_v2.model_dump(), indent=2, ensure_ascii=False, sort_keys=True
            )
        )
        return result_v2.exit_code
    if len(report_paths) > 1:
        rejected = GateResult(
            state=STATE_GATE_ERROR,
            exitCode=EXIT_CODES[STATE_GATE_ERROR],
            evaluatedAt=datetime.now(UTC).isoformat(),
            errorCode="multiple_reports_require_gate_schema_2",
        )
        print(json.dumps(rejected.model_dump(by_alias=True), indent=2, ensure_ascii=False, sort_keys=True))
        return rejected.exit_code
    result = evaluate_gate(
        report_path=report_paths[0],
        baseline_path=baseline_path,
        config_path=config_path,
        target_commit=args.target_commit,
    )
    print(json.dumps(result.model_dump(by_alias=True), indent=2, ensure_ascii=False, sort_keys=True))
    return result.exit_code


def _git_commit() -> str:
    import subprocess

    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=False, timeout=10
        ).stdout.strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m xihe_agent.evaluation")
    sub = parser.add_subparsers(dest="command")
    validate = sub.add_parser("validate", help="validate the dataset contract")
    validate.add_argument("--dataset")
    compare = sub.add_parser("compare", help="diff two evaluation reports")
    compare.add_argument("--baseline", required=True)
    compare.add_argument("--candidate", required=True)
    run = sub.add_parser("run", help="run one task lane against a live local CP")
    run.add_argument("--lane", required=True, choices=["invariant", "behavior"])
    run.add_argument("--attempts", type=int, help="behavior-lane attempt override")
    run.add_argument("--min-valid-attempts", type=int, default=3)
    run.add_argument("--dataset")
    run.add_argument("--mode")
    run.add_argument("--output-dir")
    run.add_argument("--cp-url")
    run.add_argument("--token")
    run.add_argument("--provider")
    run.add_argument("--model")
    run.add_argument("--agent-principal")
    run.add_argument("--only", help="comma-separated taskId filter")
    run.add_argument("--timeout")
    run.add_argument("--tool-surface", action="store_true", help="enable tool-requiring categories")
    gate = sub.add_parser("gate", help="quality-regression gate over reports (PLAN-0512/0540)")
    gate.add_argument(
        "--report",
        required=True,
        action="append",
        help="evaluation report; repeat once per lane for schema 2",
    )
    gate.add_argument("--baseline")
    gate.add_argument("--config", help="defaults to evaluation/gate-v2.json")
    gate.add_argument("--target-commit", help="defaults to the current git HEAD")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    command = args.command or "validate"
    if command == "validate":
        return _cmd_validate(args)
    if command == "compare":
        return _cmd_compare(args)
    if command == "gate":
        return _cmd_gate(args)
    return _cmd_run(args)


if __name__ == "__main__":
    sys.exit(main())
