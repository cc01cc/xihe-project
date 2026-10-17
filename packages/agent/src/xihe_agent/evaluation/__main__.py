"""CLI for the offline evaluation suite (PLAN-0511).

Implemented: `validate` (dataset contract) and `compare` (report diff).
Not yet implemented: `run` (needs a live local CP + Provider credentials, gate G4).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from xihe_agent.evaluation import DATASET_VERSION, dataset_sha256, load_dataset
from xihe_agent.evaluation.compare import compare_reports
from xihe_agent.evaluation.report import EvalReport


def _cmd_validate(args: argparse.Namespace) -> int:
    tasks = load_dataset()
    print(f"dataset={DATASET_VERSION} tasks={len(tasks)} sha256={dataset_sha256()}")
    for task in tasks:
        print(f"  {task.task_id} [{task.category}] assertions={len(task.hard_assertions)}")
    return 0


def _load_report(path: str) -> EvalReport:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return EvalReport.model_validate(data)


def _cmd_compare(args: argparse.Namespace) -> int:
    baseline = _load_report(args.baseline)
    candidate = _load_report(args.candidate)
    diff = compare_reports(baseline, candidate)
    print(json.dumps(diff.model_dump(), indent=2, sort_keys=True))
    return 0


def _cmd_run(args: argparse.Namespace) -> int:
    import os

    from xihe_agent.evaluation.cp_http import HttpCpClient
    from xihe_agent.evaluation.loader import DATASET_VERSION, dataset_sha256
    from xihe_agent.evaluation.runner import run_dataset

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

    dataset_path = Path(args.dataset) if args.dataset else None
    tasks = [t for t in load_dataset(dataset_path) if not only or t.task_id in only]
    if not tasks:
        print("no tasks selected", file=sys.stderr)
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
        report = run_dataset(
            client,
            tasks,
            eval_run_id=Path(eval_run_id).name,
            commit=commit,
            dataset_version=DATASET_VERSION,
            dataset_hash=dataset_sha256(dataset_path),
            provider=provider,
            model=model,
            timeout_s=timeout_s,
        )
    finally:
        client.close()
    out = Path(eval_run_id)
    out.mkdir(parents=True, exist_ok=True)
    report_path = out / "report.json"
    report_path.write_text(json.dumps(report.model_dump(), indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {report_path}")
    print(json.dumps(report.aggregate, ensure_ascii=False))
    return 0


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
    sub.add_parser("validate", help="validate the fixed dataset contract")
    compare = sub.add_parser("compare", help="diff two evaluation reports")
    compare.add_argument("--baseline", required=True)
    compare.add_argument("--candidate", required=True)
    run = sub.add_parser("run", help="run the fixed task set against a live local CP")
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
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    command = args.command or "validate"
    if command == "validate":
        return _cmd_validate(args)
    if command == "compare":
        return _cmd_compare(args)
    return _cmd_run(args)


if __name__ == "__main__":
    sys.exit(main())
