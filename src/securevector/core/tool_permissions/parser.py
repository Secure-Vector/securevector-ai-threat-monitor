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

    Handles:
    - OpenAI: choices[].message.tool_calls[]
    - Anthropic: content[].type=tool_use

    Returns empty list for unrecognizable formats (fail-open).

    Args:
        response_body: Parsed JSON response body from LLM API.

    Returns:
        List of ToolCall objects found in the response.
    """
    tool_calls = []

    try:
        # OpenAI format: choices[].message.tool_calls[]
        tool_calls.extend(_extract_openai_tool_calls(response_body))

        # Anthropic format: content[].type=tool_use
        tool_calls.extend(_extract_anthropic_tool_calls(response_body))

    except Exception as e:
        logger.warning(f"Error extracting tool calls: {e}")

    return tool_calls


def _extract_openai_tool_calls(body: dict) -> list[ToolCall]:
    """Extract tool calls from OpenAI format responses."""
    tool_calls = []

    choices = body.get("choices", [])
    if not isinstance(choices, list):
        return tool_calls

    for choice_idx, choice in enumerate(choices):
        if not isinstance(choice, dict):
            continue

        message = choice.get("message", {})
        if not isinstance(message, dict):
            continue

        tc_list = message.get("tool_calls", [])
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
