"""task-83 (D-1869): a woken run is told it is the addressee; a root run is not.

The measured defect: dispatched runs answered in the dispatcher's voice, because the
branch transcript was their only identity signal. The frame is agent-side assembly on the
delivered text only - it must not leak into root runs and must not embed participant
names (those belong to the roster the model reads for itself).
"""

from xihe_agent.api.chat import WAKEE_ADDRESSEE_FRAME, model_input_content


def test_root_run_gets_the_delivered_text_unchanged() -> None:
    assert model_input_content("请把这件事交给另一位 agent。", None) == "请把这件事交给另一位 agent。"


def test_blank_parent_run_id_counts_as_root_run() -> None:
    # CP omits the key for root runs; an empty string must not fabricate a woken frame.
    assert model_input_content("普通提问", "") == "普通提问"


def test_woken_run_gets_addressee_frame_before_the_delivered_task() -> None:
    task = "核对 branchId 的主干读数并回一行结论。"
    out = model_input_content(task, "parent-run-1")
    assert out.startswith(WAKEE_ADDRESSEE_FRAME)
    assert out.endswith(task)


def test_frame_carries_no_participant_names() -> None:
    for name in ("xhLead", "ewLead", "GhostWriterZ"):
        assert name not in WAKEE_ADDRESSEE_FRAME
