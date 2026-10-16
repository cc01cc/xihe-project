"""Run-scoped, in-memory delivery for credential acquisition results.

The handoff is deliberately separate from AgentContext and LangGraph state.
Only a provider-request copy of a marked ToolMessage is hydrated; graph state
and checkpoint projections retain the fixed placeholder.
"""

import json
from collections.abc import Mapping, Sequence
from typing import Any

from langchain_core.messages import BaseMessage, ToolMessage

from xihe_agent.interfaces.tool import (
    ACQUIRE_CREDENTIAL_TOOL_NAME,
    CREDENTIAL_DELIVERED_PLACEHOLDER,
    CREDENTIAL_HANDOFF_REQUIRED_KEY,
)


class CredentialHandoffError(RuntimeError):
    """A generic handoff failure that never includes a credential or call id."""


class _JsonObjectPairs:
    """Preserve every JSON object entry so duplicate secret keys are scanned."""

    __slots__ = ("items",)

    def __init__(self, items: list[tuple[str, Any]]) -> None:
        self.items = items


class RunScopedCredentialHandoff:
    """Keep current-Run credential outputs outside graph state until Run end."""

    __slots__ = ("_values", "_secrets", "_closed")

    def __init__(self) -> None:
        self._values: dict[str, str] = {}
        self._secrets: set[str] = set()
        self._closed = False

    def store(self, tool_call_id: str, model_content: str, secret_material: Any = None) -> None:
        """Associate one successful result with its originating model tool call."""
        if (
            self._closed
            or not isinstance(tool_call_id, str)
            or not tool_call_id
            or len(tool_call_id) > 128
            or "\x00" in tool_call_id
            or not isinstance(model_content, str)
            or not model_content
        ):
            raise CredentialHandoffError("Credential handoff is unavailable")
        if tool_call_id in self._values:
            raise CredentialHandoffError("Credential handoff identity is ambiguous")
        self._values[tool_call_id] = model_content
        self._secrets.update(self._secret_fragments(secret_material))

    def hydrate_for_request(self, messages: Sequence[BaseMessage]) -> list[BaseMessage]:
        """Return provider-only copies hydrated by exact originating call id.

        The input objects are never mutated. A marked placeholder without a
        matching Run-local result indicates a restart or identity mismatch and
        fails closed before a provider request is sent.
        """
        if self._closed:
            raise CredentialHandoffError("Credential handoff is unavailable")

        hydrated: list[BaseMessage] = []
        matched_ids: set[str] = set()
        for message in messages:
            if not isinstance(message, ToolMessage) or message.name != ACQUIRE_CREDENTIAL_TOOL_NAME:
                hydrated.append(message)
                continue

            marker = message.additional_kwargs.get(CREDENTIAL_HANDOFF_REQUIRED_KEY)
            if marker is None:
                # EventStore history is already a safe, fixed placeholder and
                # is useful context even when it predates this Run. Do not turn
                # that historical marker into a failed Run-local handoff.
                if (
                    message.additional_kwargs
                    or message.response_metadata
                    or message.artifact is not None
                    or message.status != "success"
                    or message.content != CREDENTIAL_DELIVERED_PLACEHOLDER
                ):
                    raise CredentialHandoffError("Credential tool result is unsafe")
                hydrated.append(message)
                continue

            if (
                marker is not True
                or message.additional_kwargs != {CREDENTIAL_HANDOFF_REQUIRED_KEY: True}
                or message.response_metadata
                or message.artifact is not None
                or message.status != "success"
                or message.content != CREDENTIAL_DELIVERED_PLACEHOLDER
                or not isinstance(message.tool_call_id, str)
            ):
                raise CredentialHandoffError("Credential tool result is unsafe")
            tool_call_id = message.tool_call_id
            if tool_call_id in matched_ids:
                raise CredentialHandoffError("Credential handoff identity is ambiguous")
            value = self._values.get(tool_call_id)
            if value is None:
                raise CredentialHandoffError("Credential handoff is unavailable")
            matched_ids.add(tool_call_id)
            hydrated.append(
                ToolMessage(
                    content=value,
                    tool_call_id=tool_call_id,
                    name=ACQUIRE_CREDENTIAL_TOOL_NAME,
                    id=message.id,
                    status="success",
                )
            )

        # A model request may occur before the tool result is appended or
        # after context pruning removed that result. Keep unmatched values
        # private for the rest of this Run; only a marked message without an
        # exact call-id match is an unsafe restoration/mismatch.
        return hydrated

    def reject_secret_echo(self, value: Any) -> None:
        """Prevent a model response from placing a delivered value back in state."""
        if self._contains_secret(value):
            raise CredentialHandoffError("Model response contains credential data")

    def _contains_secret(self, value: Any) -> bool:
        if isinstance(value, str):
            return any(secret in value for secret in self._secrets)
        if isinstance(value, Mapping):
            return any(self._contains_secret(key) or self._contains_secret(item) for key, item in value.items())
        if isinstance(value, (list, tuple, set)):
            return any(self._contains_secret(item) for item in value)
        return False

    def secrets_for_stream_filter(self) -> tuple[str, ...]:
        """Return transient values only to the in-process response filter."""
        if self._closed:
            return ()
        return tuple(sorted(self._secrets, key=len, reverse=True))

    def clear(self) -> None:
        """Drop all Run-local values and reject any later reuse."""
        self._values.clear()
        self._secrets.clear()
        self._closed = True

    @property
    def pending_count(self) -> int:
        """Non-sensitive diagnostic used by scoped lifecycle tests."""
        return len(self._values)

    @classmethod
    def _secret_fragments(cls, value: Any, *, sensitive_key: bool = True) -> set[str]:
        fragments: set[str] = set()
        if isinstance(value, str):
            try:
                decoded = json.loads(value, object_pairs_hook=_JsonObjectPairs)
            except (TypeError, ValueError):
                return {value} if sensitive_key else fragments
            if isinstance(decoded, (_JsonObjectPairs, list)):
                fragments.update(cls._secret_fragments(decoded))
            elif sensitive_key and value:
                # A credential field may itself contain a JSON scalar string;
                # retain that exact field value, but never buffer a complete
                # ordinary JSON tool response as one stream secret.
                fragments.add(value)
        elif isinstance(value, _JsonObjectPairs):
            sensitive_fields = {
                "apikey",
                "authorization",
                "accesstoken",
                "cookie",
                "credential",
                "credentialvalue",
                "password",
                "refreshtoken",
                "secret",
                "token",
                "value",
            }
            for key, item in value.items:
                key_is_sensitive = (
                    isinstance(key, str) and key.replace("-", "").replace("_", "").lower() in sensitive_fields
                )
                fragments.update(cls._secret_fragments(item, sensitive_key=key_is_sensitive))
        elif isinstance(value, Mapping):
            sensitive_fields = {
                "apikey",
                "authorization",
                "accesstoken",
                "cookie",
                "credential",
                "credentialvalue",
                "password",
                "refreshtoken",
                "secret",
                "token",
                "value",
            }
            for key, item in value.items():
                key_is_sensitive = (
                    isinstance(key, str) and key.replace("-", "").replace("_", "").lower() in sensitive_fields
                )
                fragments.update(cls._secret_fragments(item, sensitive_key=key_is_sensitive))
        elif isinstance(value, (list, tuple, set)):
            for item in value:
                fragments.update(cls._secret_fragments(item, sensitive_key=sensitive_key))
        return fragments


class StreamingSecretRedactor:
    """Keep credential substrings out of streamed model output across chunks."""

    __slots__ = ("_secrets", "_pending")

    def __init__(self, secrets: Sequence[str]) -> None:
        self._secrets = tuple(secret for secret in secrets if secret)
        self._pending = ""

    def feed(self, chunk: str) -> str:
        if not self._secrets:
            return chunk
        combined = self._pending + chunk
        maximum = max(map(len, self._secrets))
        release_end = max(0, len(combined) - maximum + 1)

        for secret in self._secrets:
            start = combined.find(secret)
            while start >= 0:
                end = start + len(secret)
                if start < release_end < end:
                    release_end = start
                start = combined.find(secret, start + 1)

            overlap_limit = min(len(secret) - 1, len(combined))
            for overlap in range(overlap_limit, 0, -1):
                if combined.endswith(secret[:overlap]):
                    release_end = min(release_end, len(combined) - overlap)
                    break

        released = combined[:release_end]
        self._pending = combined[release_end:]
        for secret in self._secrets:
            released = released.replace(secret, "[credential redacted]")
        return released

    def finish(self) -> str:
        """Flush the final safe tail after replacing any complete secret."""
        result = self._pending
        self._pending = ""
        for secret in self._secrets:
            result = result.replace(secret, "[credential redacted]")
        return result

    def clear(self) -> None:
        self._pending = ""
