"""
Tool call parser for LLM responses.

Extracts tool call instructions from LLM API response bodies,
handling both OpenAI and Anthropic formats.
"""

import hashlib
import json
import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class ToolCall:
    """Represents a single tool call extracted from an LLM response."""

    function_name: str
    arguments_hash: str
    provider_format: str  # "openai" or "anthropic"
    arguments: Optional[str] = None
    tool_call_id: Optional[str] = None
    index: Optional[int] = None


def _hash_arguments(arguments) -> str:
    """Create a stable hash of tool call arguments."""
    if isinstance(arguments, str):
        return hashlib.sha256(arguments.encode()).hexdigest()[:16]
    elif isinstance(arguments, dict):
        return hashlib.sha256(
            json.dumps(arguments, sort_keys=True).encode()
        ).hexdigest()[:16]
    return hashlib.sha256(b"").hexdigest()[:16]


def extract_tool_calls(response_body: dict) -> list[ToolCall]:
    """Extract tool calls from an LLM API response body.

    Handles both complete responses and SSE streaming chunks:
    - OpenAI complete:   choices[].message.tool_calls[]
    - OpenAI streaming:  choices[].delta.tool_calls[]
    - Anthropic complete: content[].type=tool_use
    - Anthropic streaming: type=content_block_start, content_block.type=tool_use

    Returns empty list for unrecognizable formats (fail-open).

    Args:
        response_body: Parsed JSON response body from LLM API.

    Returns:
        List of ToolCall objects found in the response.
    """
    tool_calls = []

    try:
        # OpenAI complete + streaming: choices[].message|delta.tool_calls[]
        tool_calls.extend(_extract_openai_tool_calls(response_body))

        # Anthropic complete: content[].type=tool_use
        tool_calls.extend(_extract_anthropic_tool_calls(response_body))

        # Anthropic streaming: content_block_start event
        tool_calls.extend(_extract_anthropic_streaming_tool_calls(response_body))

        # Gemini complete + streaming: candidates[].content.parts[].functionCall
        tool_calls.extend(_extract_gemini_tool_calls(response_body))

        # Cohere v1: top-level tool_calls[].name + parameters
        tool_calls.extend(_extract_cohere_tool_calls(response_body))

    except Exception as e:
        logger.warning(f"Error extracting tool calls: {e}")

    return tool_calls


def _extract_openai_tool_calls(body: dict) -> list[ToolCall]:
    """Extract tool calls from OpenAI format responses (complete and streaming).

    Complete:  choices[].message.tool_calls[]
    Streaming: choices[].delta.tool_calls[]
    """
    tool_calls = []

    choices = body.get("choices", [])
    if not isinstance(choices, list):
        return tool_calls

    for choice_idx, choice in enumerate(choices):
        if not isinstance(choice, dict):
            continue

        # Complete response uses "message"; streaming uses "delta"
        container = choice.get("message") or choice.get("delta") or {}
        if not isinstance(container, dict):
            continue

        tc_list = container.get("tool_calls", [])
        if not isinstance(tc_list, list):
            continue

        for tc_idx, tc in enumerate(tc_list):
            if not isinstance(tc, dict):
                continue

            function = tc.get("function", {})
            if not isinstance(function, dict):
                continue

            name = function.get("name")
            if not name:
                continue

            arguments = function.get("arguments", "")
            tool_calls.append(
                ToolCall(
                    function_name=name,
                    arguments_hash=_hash_arguments(arguments),
                    arguments=arguments if isinstance(arguments, str) else json.dumps(arguments),
                    provider_format="openai",
                    tool_call_id=tc.get("id"),
                    index=tc_idx,
                )
            )

    return tool_calls


def _extract_anthropic_streaming_tool_calls(body: dict) -> list[ToolCall]:
    """Extract tool calls from Anthropic SSE streaming chunks.

    Streaming format (content_block_start event):
      {"type": "content_block_start", "index": 1,
       "content_block": {"type": "tool_use", "id": "toolu_x", "name": "browser_navigate", "input": {}}}
    """
    tool_calls = []

    if body.get("type") != "content_block_start":
        return tool_calls

    block = body.get("content_block", {})
    if not isinstance(block, dict) or block.get("type") != "tool_use":
        return tool_calls

    name = block.get("name")
    if not name:
        return tool_calls

    arguments = block.get("input", {})
    tool_calls.append(
        ToolCall(
            function_name=name,
            arguments_hash=_hash_arguments(arguments),
            arguments=json.dumps(arguments) if isinstance(arguments, dict) else str(arguments),
            provider_format="anthropic",
            tool_call_id=block.get("id"),
            index=body.get("index"),
        )
    )

    return tool_calls


def _extract_anthropic_tool_calls(body: dict) -> list[ToolCall]:
    """Extract tool calls from Anthropic format responses."""
    tool_calls = []

    content = body.get("content", [])
    if not isinstance(content, list):
        return tool_calls

    # Avoid misidentifying OpenAI responses that also have "content"
    if "choices" in body:
        return tool_calls

    for idx, block in enumerate(content):
        if not isinstance(block, dict):
            continue

        if block.get("type") != "tool_use":
            continue

        name = block.get("name")
        if not name:
            continue

        arguments = block.get("input", {})
        tool_calls.append(
            ToolCall(
                function_name=name,
                arguments_hash=_hash_arguments(arguments),
                arguments=json.dumps(arguments) if isinstance(arguments, dict) else str(arguments),
                provider_format="anthropic",
                tool_call_id=block.get("id"),
                index=idx,
            )
        )

    return tool_calls


def _extract_gemini_tool_calls(body: dict) -> list[ToolCall]:
    """Extract tool calls from Gemini format responses (complete and streaming).

    Complete:  candidates[].content.parts[].functionCall.name
    Streaming: same structure per chunk
    """
    tool_calls = []

    candidates = body.get("candidates", [])
    if not isinstance(candidates, list):
        return tool_calls

    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue

        content = candidate.get("content", {})
        if not isinstance(content, dict):
            continue

        parts = content.get("parts", [])
        if not isinstance(parts, list):
            continue

        for idx, part in enumerate(parts):
            if not isinstance(part, dict):
                continue

            fc = part.get("functionCall", {})
            if not isinstance(fc, dict) or not fc.get("name"):
                continue

            name = fc["name"]
            arguments = fc.get("args", {})
            tool_calls.append(
                ToolCall(
                    function_name=name,
                    arguments_hash=_hash_arguments(arguments),
                    arguments=json.dumps(arguments) if isinstance(arguments, dict) else str(arguments),
                    provider_format="gemini",
                    index=idx,
                )
            )

    return tool_calls


def _extract_cohere_tool_calls(body: dict) -> list[ToolCall]:
    """Extract tool calls from Cohere v1 format (complete and streaming).

    Complete:  top-level tool_calls[].name + parameters
    Streaming: data line with event_type=tool-calls-generation, same structure
    """
    tool_calls = []

    # Avoid matching OpenAI/Anthropic/Gemini responses
    if "choices" in body or "content" in body or "candidates" in body:
        return tool_calls

    tc_list = body.get("tool_calls", [])
    if not isinstance(tc_list, list):
        return tool_calls

    for idx, tc in enumerate(tc_list):
        if not isinstance(tc, dict):
            continue

        name = tc.get("name")
        if not name:
            continue

        arguments = tc.get("parameters", {})
        tool_calls.append(
            ToolCall(
                function_name=name,
                arguments_hash=_hash_arguments(arguments),
                arguments=json.dumps(arguments) if isinstance(arguments, dict) else str(arguments),
                provider_format="cohere",
                index=idx,
            )
        )

    return tool_calls
