"""PLAN-0605: vision renderer post-transform (decision B).

The API request template owns **text** slots only (`${xh.user_input}` is typed `str`).
Multimodal payload therefore belongs to the apiType renderer: after the template is
rendered and the vision capability gate has passed, this module rewrites the *current
turn's last user message* into content parts when — and only when — image references
were dispatched by CP for this run.

Hard rules (PLAN-0605 M2):
* only the last `role=user` message of the current turn is rewritten;
* the original text is preserved verbatim as the first `text` part;
* bytes are pulled from the run-bound CP internal route, kept in memory only, and
  never logged, persisted or echoed back;
* any fetch/permission/limit failure raises a stable error instead of degrading to a
  text-only request (silent degradation is the bug this plan exists to fix).
"""

from __future__ import annotations

import base64
from collections.abc import Sequence
from typing import Any

import httpx

from xihe_agent.llm.api_request import ApiRequestError
from xihe_agent.llm.api_sender import VISION_RENDERERS

SUPPORTED_IMAGE_MIMES: frozenset[str] = frozenset({"image/png", "image/jpeg", "image/webp"})
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGES_PER_MESSAGE = 4
FETCH_TIMEOUT_SECONDS = 10.0


def normalize_image_refs(raw: Any) -> list[dict[str, Any]]:
    """Validate the CP-dispatched `images[]` refs; returns an empty list when absent."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ApiRequestError("INVALID_REQUEST_SHAPE")
    refs: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ApiRequestError("INVALID_REQUEST_SHAPE")
        attachment_id = item.get("attachmentId")
        mime = item.get("mimeType")
        size = item.get("sizeBytes")
        if not isinstance(attachment_id, str) or not attachment_id:
            raise ApiRequestError("INVALID_REQUEST_SHAPE")
        if not isinstance(mime, str) or mime.lower() not in SUPPORTED_IMAGE_MIMES:
            raise ApiRequestError("LLM_VISION_ATTACHMENT_UNSUPPORTED")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise ApiRequestError("INVALID_REQUEST_SHAPE")
        if size > MAX_IMAGE_BYTES:
            raise ApiRequestError("LLM_VISION_ATTACHMENT_TOO_LARGE")
        refs.append({"attachmentId": attachment_id, "mimeType": mime.lower(), "sizeBytes": size})
    if len(refs) > MAX_IMAGES_PER_MESSAGE:
        raise ApiRequestError("LLM_VISION_ATTACHMENT_TOO_LARGE")
    return refs


async def fetch_image_data_urls(
    refs: Sequence[dict[str, Any]],
    *,
    cp_url: str,
    service_token: str,
    run_id: str,
    workspace_id: str | None,
    timeout: float = FETCH_TIMEOUT_SECONDS,
) -> list[str]:
    """Pull image bytes over the run-bound internal route and inline them as data URLs.

    Nothing is written to disk or logs: only the resulting data URLs are returned and
    they live for the lifetime of one provider request.
    """
    if not refs:
        return []
    base = cp_url.rstrip("/")
    headers = {"Authorization": f"Bearer {service_token}"}
    if workspace_id:
        headers["X-Workspace-Id"] = workspace_id
    urls: list[str] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        for ref in refs:
            url = f"{base}/internal/v1/attachments/{ref['attachmentId']}/content?runId={run_id}"
            try:
                response = await client.get(url, headers=headers)
            except httpx.HTTPError as exc:  # network/timeout: fail closed, never degrade
                raise ApiRequestError("LLM_VISION_ATTACHMENT_UNAVAILABLE", 502) from exc
            if response.status_code != 200:
                raise ApiRequestError("LLM_VISION_ATTACHMENT_UNAVAILABLE", 502)
            payload = response.content
            if len(payload) > MAX_IMAGE_BYTES:
                raise ApiRequestError("LLM_VISION_ATTACHMENT_TOO_LARGE")
            encoded = base64.b64encode(payload).decode("ascii")
            urls.append(f"data:{ref['mimeType']};base64,{encoded}")
    return urls


def apply_image_parts(
    body: dict[str, Any],
    api_type_id: str,
    data_urls: Sequence[str],
) -> dict[str, Any]:
    """Rewrite the last user message of this turn into text+image content parts.

    Returns the *same* body object untouched when there is nothing to render, so
    text-only runs keep byte-identical payloads.
    """
    if not data_urls or api_type_id not in VISION_RENDERERS:
        return body
    messages = body.get("messages")
    if not isinstance(messages, list):
        raise ApiRequestError("INVALID_REQUEST_SHAPE")
    target_index = None
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if isinstance(message, dict) and message.get("role") == "user":
            target_index = index
            break
    if target_index is None:
        raise ApiRequestError("INVALID_REQUEST_SHAPE")
    target = messages[target_index]
    text = target.get("content")
    if not isinstance(text, str):
        # never guess: a non-string user content means the template changed shape
        raise ApiRequestError("INVALID_REQUEST_SHAPE")
    parts: list[dict[str, Any]] = [{"type": "text", "text": text}]
    parts.extend({"type": "image_url", "image_url": {"url": data_url}} for data_url in data_urls)
    target["content"] = parts
    return body
