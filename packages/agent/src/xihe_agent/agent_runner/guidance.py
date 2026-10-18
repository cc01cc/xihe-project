"""PLAN-0529: in-run Guidance consumption for the main Chat Runner.

Frozen protocol: ``spec/agent-guidance-consume-protocol.md`` (this repo) and the
parent contract ``plans/PLAN-0468-xh-chat-run-guidance/spec/target-contract.md``
§4. Upstream wire is PLAN-0528's CP surface (``/internal/v1/chat/runs/{runId}/
guidance/pending`` + ``.../{guidanceId}/consume``).

Core idea: a model-call pre-injection wrapper. The moment the LLM is invoked is
exactly the frozen consumption point — every tool dispatched in the previous
batch has completed, and the next planning step has not happened yet. Injected
HumanMessages are transient (they shape this one call only); they never enter
the LangGraph ``messages`` channel, the EventStore transcript, or the
checkpoint, so consumed guidance never leaks into a continuation run's context.
"""

import json
from typing import Any

import httpx
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import HumanMessage
from langchain_core.outputs import ChatResult
from loguru import logger

GUIDANCE_INJECT_KEY_HEADER = "Idempotency-Key"
GUIDANCE_ALREADY_EXPIRED = "GUIDANCE_ALREADY_TERMINAL_EXPIRED"
ENVELOPE_PREFIX = "[guidance]"


def build_guidance_envelope(sequence: int, content: str) -> str:
    """Untrusted-input envelope: the model must be able to tell guidance apart
    from ordinary user turns and system policy (parent contract §4)."""
    return f"{ENVELOPE_PREFIX} (source=user, seq={sequence})\n{content}"


class GuidanceConsumer:
    """Reads pending guidance from CP and acknowledges injection (0528 wire).

    Dedup is three-layered (frozen §2): a stream-scoped ``injected_ids`` set,
    the CP idempotency key, and the terminal-expired 409 stop signal.
    """

    def __init__(self, base_url: str, service_token: str, run_id: str,
                 timeout: float = 30.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._run_id = run_id
        self._client = httpx.AsyncClient(timeout=timeout)
        self._headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {service_token}",
        }
        self.injected_ids: set[str] = set()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def fetch_pending(self) -> list[dict[str, Any]]:
        """Pending items in CP sequence order; failures are fail-open (warn +
        empty list) because guidance carries no authorization semantics."""
        url = f"{self._base_url}/internal/v1/chat/runs/{self._run_id}/guidance/pending"
        try:
            response = await self._client.get(url, headers=self._headers)
            response.raise_for_status()
            payload = response.json()
        except Exception as e:  # noqa: BLE001 — fail-open by contract §2
            logger.warning("guidance pending read failed, continuing guidance-less: {}", e)
            return []
        items = payload.get("items")
        return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []

    async def consume(self, guidance_id: str) -> bool:
        """Acknowledge injection. Returns True when the id is settled (consumed
        or already terminal-expired → stop-signal recorded). False = transient
        failure, the id stays eligible for a later boundary retry."""
        url = (
            f"{self._base_url}/internal/v1/chat/runs/{self._run_id}/guidance/"
            f"{guidance_id}/consume"
        )
        try:
            response = await self._client.post(
                url,
                headers={**self._headers, GUIDANCE_INJECT_KEY_HEADER: f"guidance-{guidance_id}"},
                content=json.dumps({"consumedBy": "agent-runner"}),
            )
        except Exception as e:  # noqa: BLE001 — retry at the next boundary
            logger.warning("guidance consume request failed id={}: {}", guidance_id, e)
            return False
        if response.status_code == 409 and GUIDANCE_ALREADY_EXPIRED in response.text:
            # 0528 frozen semantics: stop retrying, never inject.
            logger.info("guidance already terminal-expired id={}", guidance_id)
            self.injected_ids.add(guidance_id)
            return True
        if response.is_error:
            logger.warning("guidance consume failed id={} status={}", guidance_id, response.status_code)
            return False
        self.injected_ids.add(guidance_id)
        logger.info("guidance consumed id={}", guidance_id)
        return True

    async def collect_new(self) -> list[dict[str, Any]]:
        """Pending items not yet injected, sorted by CP sequence (ruling 2A).

        The CP endpoint promises ascending sequence, but the consumer sorts
        defensively: injection order is a frozen semantic, not a network hope.
        """
        pending = await self.fetch_pending()
        fresh = [item for item in pending if str(item.get("id")) not in self.injected_ids]
        return sorted(fresh, key=lambda item: int(item.get("sequence") or 0))


class GuidanceInjectionModel(BaseChatModel):
    """Wraps the chat model and appends pending guidance to each invocation.

    The wrapper sees the model call at exactly the frozen consumption point:
    the previous tool batch has completed (LangGraph only calls the model node
    again after every tool in the batch resolved) and this planning step has
    not produced anything yet. Injection is transient — a copy of the incoming
    messages is shaped, the original list reference is untouched.
    """

    consumer: Any = None
    inner: Any = None

    @property
    def _llm_type(self) -> str:
        return "xihe-guidance-injecting"

    def __getattr__(self, name: str) -> Any:
        """Proxy everything else (ainvoke, usage collectors, token sinks…) to
        the wrapped model, so the wrapper is transparent to the runner."""
        if name.startswith("__"):
            raise AttributeError(name)
        inner = self.__dict__.get("inner")
        if inner is None:
            raise AttributeError(name)
        return getattr(inner, name)

    def bind_tools(self, tools: Any, **kwargs: Any) -> "GuidanceInjectionModel":
        cloned = GuidanceInjectionModel(consumer=self.consumer, inner=self.inner.bind_tools(tools, **kwargs))
        return cloned

    def _envelop(self, messages: list[Any]) -> list[Any]:
        return list(messages)

    async def _drain_guidance(self) -> list[Any]:
        if self.consumer is None:
            return []
        try:
            pending = await self.consumer.collect_new()
        except Exception as e:  # noqa: BLE001 — fail-open by contract §2
            logger.warning("guidance drain failed: {}", e)
            return []
        messages: list[Any] = []
        for item in pending:
            guidance_id = str(item.get("id"))
            sequence = item.get("sequence")
            content = item.get("content")
            if not content:
                continue
            messages.append(HumanMessage(content=build_guidance_envelope(sequence, content)))
            await self.consumer.consume(guidance_id)
        return messages

    def _generate(self, messages: list[Any], stop: list[str] | None = None,
                  run_manager: Any = None, **kwargs: Any) -> ChatResult:
        raise NotImplementedError("chat runner drives the model asynchronously")

    async def _agenerate(self, messages: list[Any], stop: list[str] | None = None,
                         run_manager: Any = None, **kwargs: Any) -> ChatResult:
        injected = await self._drain_guidance()
        effective = self._envelop(list(messages)) + injected
        return await self.inner._agenerate(effective, stop=stop, run_manager=run_manager, **kwargs)  # noqa: SLF001

    async def _astream(self, messages: list[Any], stop: list[str] | None = None,
                       run_manager: Any = None, **kwargs: Any) -> Any:
        injected = await self._drain_guidance()
        effective = self._envelop(list(messages)) + injected
        async for chunk in self.inner._astream(effective, stop=stop, run_manager=run_manager, **kwargs):  # noqa: SLF001
            yield chunk
