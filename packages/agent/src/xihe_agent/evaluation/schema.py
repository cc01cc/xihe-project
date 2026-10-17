"""Pydantic schema for the versioned offline evaluation dataset (PLAN-0511)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

DATASET_SCHEMA_VERSION = 1


class HardAssertion(BaseModel):
    """A deterministic assertion evaluated against a Run's observable facts."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    assertion_id: str = Field(alias="assertionId")
    kind: str
    expected: dict[str, Any]
    observation: str | None = None
    description: str | None = None


class EvalInput(BaseModel):
    """The synthetic model input for one evaluation task."""

    model_config = ConfigDict(extra="forbid")

    messages: list[dict[str, Any]]


class EvalTask(BaseModel):
    """One versioned evaluation task record from the dataset."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    schema_version: int = Field(alias="schemaVersion")
    task_id: str = Field(alias="taskId")
    task_version: str = Field(alias="taskVersion")
    category: str
    input: EvalInput
    context_fixture_id: str = Field(alias="contextFixtureId")
    context_fixture: dict[str, Any] | None = Field(default=None, alias="contextFixture")
    allowed_tools: list[str] = Field(default_factory=list, alias="allowedTools")
    denied_tools: list[str] = Field(default_factory=list, alias="deniedTools")
    hard_assertions: list[HardAssertion] = Field(min_length=1, alias="hardAssertions")
    judge_rubric_id: str | None = Field(default=None, alias="judgeRubricId")
    data_class: Literal["synthetic"] = Field(alias="dataClass")
