"""CLI entrypoint placeholder for the offline evaluation suite (PLAN-0511).

Milestone M1 exposes dataset validation only. `run`, `compare` (PLAN-0511 M2/M3)
and `gate` (PLAN-0512) subcommands are added later per spec/evaluation-contract.md.
"""

from __future__ import annotations

import sys

from xihe_agent.evaluation import DATASET_VERSION, dataset_sha256, load_dataset


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    unknown = [a for a in args if not a.startswith("-")]
    if unknown:
        print(f"unsupported arguments (run/compare/gate not implemented yet): {unknown}", file=sys.stderr)
        return 2
    tasks = load_dataset()
    print(f"dataset={DATASET_VERSION} tasks={len(tasks)} sha256={dataset_sha256()}")
    for task in tasks:
        print(f"  {task.task_id} [{task.category}] assertions={len(task.hard_assertions)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
