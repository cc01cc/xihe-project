"""Pydantic schema for the versioned offline evaluation dataset (PLAN-0511/0540).

v1 rows use camelCase and stay read-only. v2 rows are strict snake_case and add
the task-level `assertion_class` and `attempts` fields (PLAN-0540).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

DATASET_SCHEMA_VERSION = 2
V1_SCHEMA_VERSION = 1
V2_SCHEMA_VERSION = 2
SUPPORTED_DATASET_SCHEMA_VERSIONS = (V1_SCHEMA_VERSION, V2_SCHEMA_VERSION)


class HardAssertion(BaseModel):
    """A deterministic assertion evaluated against a Run's observable facts (v1)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    assertion_id: str = Field(alias="assertionId")
    kind: str
    expected: dict[str, Any]
    observation: str | None = None
    description: str | None = None


class HardAssertionV2(BaseModel):
    """v2 assertion: strict snake_case keys, no camelCase aliases."""

    model_config = ConfigDict(extra="forbid")

    assertion_id: str
    kind: str
    expected: dict[str, Any]
    observation: str | None = None
    description: str | None = None


AssertionLike = HardAssertion | HardAssertionV2


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


class EvalTaskV2(BaseModel):
    """One v2 evaluation task: snake_case keys plus lane and attempt budget."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2]
    task_id: str
    task_version: str
    assertion_class: Literal["invariant", "behavior"]
    attempts: int = Field(ge=1)
    category: str
    input: EvalInput
    context_fixture_id: str
    context_fixture: dict[str, Any] | None = None
    allowed_tools: list[str] = Field(default_factory=list)
    denied_tools: list[str] = Field(default_factory=list)
    hard_assertions: list[HardAssertionV2] = Field(min_length=1)
    judge_rubric_id: str | None = None
    data_class: Literal["synthetic"]


EvalTaskLike = EvalTask | EvalTaskV2
