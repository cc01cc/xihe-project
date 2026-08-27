"""HTTP client for the CP Context Service and Event Store."""

from datetime import datetime
from typing import Any

import httpx

from xihe_agent.interfaces.event import Event
from xihe_agent.interfaces.event_store import EventStore


class CPContextServiceClient:
    """Client for fetching `AgentContext` snapshots from CP."""

    def __init__(self, base_url: str, api_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_token = api_token
        self._client = httpx.AsyncClient(timeout=30.0)

    async def get_context_snapshot(
        self,
        session_id: str,
        after_sequence: int = 0,
    ) -> dict[str, Any]:
        """Fetch the projected `AgentContext` snapshot for a session."""
        url = f"{self._base_url}/api/v1/context/{session_id}/snapshot"
        params = {"afterSequence": after_sequence}
        response = await self._client.get(
            url,
            params=params,
            headers=self._headers(),
        )
        response.raise_for_status()
        return response.json()

    def _headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._api_token}",
        }


class CPEventStoreClient(EventStore):
    """Client that appends domain events to the CP Event Store."""

    def __init__(self, base_url: str, api_token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_token = api_token
        self._client = httpx.AsyncClient(timeout=30.0)

    async def append(self, event: Event) -> Event:
        url = f"{self._base_url}/api/v1/context/{event.aggregate_id}/events"
        payload = self._event_to_dict(event)
        response = await self._client.post(
            url,
            json=payload,
            headers=self._headers(),
        )
        response.raise_for_status()
        data = response.json()
        return event.with_sequence(data["sequence"])

    async def append_many(self, aggregate_id: str, events: list[Event]) -> list[Event]:
        url = f"{self._base_url}/api/v1/context/{aggregate_id}/events/batch"
        payload = [self._event_to_dict(e) for e in events]
        response = await self._client.post(
            url,
            json=payload,
            headers=self._headers(),
        )
        response.raise_for_status()
        data = response.json()
        sequences = data["sequences"]
        return [e.with_sequence(seq) for e, seq in zip(events, sequences)]

    async def read(self, aggregate_id: str, after_sequence: int = 0):
        url = f"{self._base_url}/api/v1/context/{aggregate_id}/events"
        params = {"afterSequence": after_sequence}
        response = await self._client.get(
            url,
            params=params,
            headers=self._headers(),
        )
        response.raise_for_status()
        for raw in response.json():
            yield self._event_from_dict(raw)

    async def get_latest_sequence(self, aggregate_id: str) -> int:
        url = f"{self._base_url}/api/v1/context/{aggregate_id}/events/latest"
        response = await self._client.get(url, headers=self._headers())
        response.raise_for_status()
        return response.json()["sequence"]

    async def fork(
        self,
        source_aggregate_id: str,
        at_sequence: int,
        new_aggregate_id: str,
    ) -> int:
        url = f"{self._base_url}/api/v1/context/{source_aggregate_id}/fork"
        payload = {
            "atSequence": at_sequence,
            "newAggregateId": new_aggregate_id,
        }
        response = await self._client.post(url, json=payload, headers=self._headers())
        response.raise_for_status()
        return response.json()["sequence"]

    def _headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._api_token}",
        }

    def _event_to_dict(self, event: Event) -> dict[str, Any]:
        return {
            "aggregate_id": event.aggregate_id,
            "sequence": event.sequence,
            "type": event.type,
            "payload": event.payload,
            "created_at": event.created_at.isoformat(),
            "correlation_id": event.correlation_id,
            "causation_id": event.causation_id,
        }

    def _event_from_dict(self, raw: dict[str, Any]) -> Event:
        created_at_raw = raw["created_at"]
        if isinstance(created_at_raw, str):
            created_at = datetime.fromisoformat(created_at_raw)
        else:
            created_at = created_at_raw
        return Event(
            aggregate_id=raw["aggregate_id"],
            sequence=raw["sequence"],
            type=raw["type"],
            payload=raw["payload"],
            created_at=created_at,
            correlation_id=raw.get("correlation_id"),
            causation_id=raw.get("causation_id"),
        )
