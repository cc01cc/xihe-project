"""PLAN-0381 V17 rollback-reader probe against a REAL post-v2 CP snapshot.

Loads the pre-0381 AgentContext reader source from the recorded rollback base
commit, decodes the snapshot produced by the live CP Chat/MCP/Runtime run, and
asserts that the old reader still receives non-empty bounded text facts rather
than silently manufacturing empty ToolMessages. This probe performs no writes
to CP/Runtime and never fabricates events.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

OLD_READER_COMMIT = "365d3d73b15cfd4e7d645cc05adb63bfba9a81b5"
OLD_CONTEXT_PATH = "packages/agent/src/xihe_agent/interfaces/context.py"
MARKER = "PLAN0381_LARGE_MARKER"


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit("usage: probe SNAPSHOT.json OUTPUT.json PRE-0381-COMMIT")
    snapshot_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    commit = sys.argv[3]
    repo = Path(__file__).resolve().parents[3]

    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    # Use the exact pre-0381 codec source, not a reimplementation.
    result = subprocess.run(
        ["git", "-C", str(repo), "show", f"{commit}:{OLD_CONTEXT_PATH}"],
        check=True,
        capture_output=True,
        text=True,
        timeout=15,
    )
    with tempfile.TemporaryDirectory(prefix="plan0381-v17-reader-") as tmp:
        source = Path(tmp) / "context_legacy.py"
        source.write_text(result.stdout, encoding="utf-8")
        module_name = "xihe_agent.interfaces.context_legacy_v15"
        spec = importlib.util.spec_from_file_location(module_name, source)
        if spec is None or spec.loader is None:
            raise RuntimeError("could not load pre-0381 context reader module")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        try:
            spec.loader.exec_module(module)
            old_context = module.AgentContext.from_snapshot(snapshot)
            tool_messages = [
                {"role": message.role, "content": message.content}
                for message in old_context.messages
                if message.role == "tool"
            ]
        finally:
            sys.modules.pop(module_name, None)

    non_empty = [message for message in tool_messages if message["content"].strip()]
    safe_fallback = any(MARKER in message["content"] for message in non_empty)
    no_empty_tool_messages = len(non_empty) == len(tool_messages) and bool(tool_messages)
    output = {
        "pre0381ReaderCommit": commit,
        "snapshotSource": str(snapshot_path),
        "toolMessageCount": len(tool_messages),
        "nonEmptyToolMessageCount": len(non_empty),
        "toolMessages": tool_messages,
        "safeTextFallback": safe_fallback,
        "noEmptyToolMessages": no_empty_tool_messages,
        "pass": safe_fallback and no_empty_tool_messages,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in output.items() if k != "toolMessages"}, ensure_ascii=False))
    return 0 if output["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
