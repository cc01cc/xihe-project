"""task-101 (B): budget accounting - growth vs cumulative, fail-open, identity."""

from xihe_agent.interfaces.agent_runner import RunBudget
from xihe_agent.interfaces.usage import RunUsage


def test_growth_charges_input_minus_cache_plus_output() -> None:
    usage = RunUsage()
    charge = usage.record_llm_usage(input_tokens=6000, output_tokens=800, cache_read_tokens=5400)
    assert charge == 600 + 800
    assert usage.cache_read_input_tokens == 5400
    assert usage.budget_consumed == 1400
    assert usage.total_tokens == 6800


def test_missing_counter_is_fail_open_full_charge_not_zero() -> None:
    usage = RunUsage()
    charge = usage.record_llm_usage(input_tokens=6000, output_tokens=800, cache_read_tokens=None)
    assert charge == 6800
    assert usage.budget_consumed == 6800
    assert usage.cache_read_input_tokens == 0


def test_reported_zero_is_a_real_no_hit_not_missing() -> None:
    usage = RunUsage()
    charge = usage.record_llm_usage(input_tokens=6000, output_tokens=800, cache_read_tokens=0)
    assert charge == 6800
    assert usage.budget_consumed == 6800


def test_cumulative_mode_is_identical_to_old_rule() -> None:
    usage = RunUsage(budget_accounting="cumulative")
    usage.record_llm_usage(input_tokens=6000, output_tokens=800, cache_read_tokens=5400)
    assert usage.budget_consumed == usage.total_tokens == 6800


def test_identity_per_call_difference_equals_cache_read() -> None:
    calls = [(6000, 800, 5400), (7000, 700, 6300), (8000, 900, 4000)]
    real = RunUsage()
    growth = RunUsage()
    for input_tokens, output_tokens, cache in calls:
        real.record_llm_usage(input_tokens=input_tokens, output_tokens=output_tokens, cache_read_tokens=cache, accounting="cumulative")
        growth.record_llm_usage(input_tokens=input_tokens, output_tokens=output_tokens, cache_read_tokens=cache, accounting="growth")
    assert real.budget_consumed - growth.budget_consumed == growth.cache_read_input_tokens


def test_cache_read_larger_than_input_is_clamped() -> None:
    usage = RunUsage()
    charge = usage.record_llm_usage(input_tokens=1000, output_tokens=500, cache_read_tokens=9999)
    assert charge == 500
    assert usage.budget_consumed == 500
    assert usage.cache_read_input_tokens == 1000


def test_unknown_mode_falls_back_to_growth() -> None:
    usage = RunUsage(budget_accounting="nonsense")
    usage.record_llm_usage(input_tokens=100, output_tokens=0, cache_read_tokens=None)
    assert usage.budget_accounting == "growth"


def test_run_budget_carries_accounting_mode() -> None:
    assert RunBudget().budget_accounting == "growth"
    assert RunBudget(budget_accounting="cumulative").budget_accounting == "cumulative"
