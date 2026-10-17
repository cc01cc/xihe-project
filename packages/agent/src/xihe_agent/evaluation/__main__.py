"""CLI for the offline evaluation suite (PLAN-0511).

Implemented: `validate` (dataset contract) and `compare` (report diff).
Not yet implemented: `run` (needs a live local CP + Provider credentials, gate G4).
"""

from __future__ import annotations

import argparse
import json
import sys
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
    print(
        "run is not implemented yet: cp-real requires a live local CP and Provider credentials (gate G4)",
        file=sys.stderr,
    )
    return 3


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m xihe_agent.evaluation")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("validate", help="validate the fixed dataset contract")
    compare = sub.add_parser("compare", help="diff two evaluation reports")
    compare.add_argument("--baseline", required=True)
    compare.add_argument("--candidate", required=True)
    run = sub.add_parser("run", help="run the fixed task set (not implemented)")
    run.add_argument("--dataset")
    run.add_argument("--mode")
    run.add_argument("--output-dir")
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
