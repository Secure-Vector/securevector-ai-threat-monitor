"""
Manual test: aws.iam_create_user tool permission — block vs allow.

Run:  python tests/test_tool_permissions_manual.py
"""

from securevector.core.tool_permissions.parser import extract_tool_calls
from securevector.core.tool_permissions.engine import (
    load_essential_registry,
    evaluate_tool_call,
)

# ---------- Fake LLM responses containing aws.iam_create_user ----------

OPENAI_RESPONSE = {
    "id": "chatcmpl-test-123",
    "object": "chat.completion",
    "choices": [{
        "index": 0,
        "message": {
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": "call_abc123",
                "type": "function",
                "function": {
                    "name": "aws.iam_create_user",
                    "arguments": '{"username": "test-hacker", "permissions": ["AdministratorAccess"]}'
                }
            }]
        },
        "finish_reason": "tool_calls"
    }]
}

ANTHROPIC_RESPONSE = {
    "id": "msg-test-456",
    "type": "message",
    "role": "assistant",
    "content": [
        {"type": "text", "text": "I'll create that IAM user for you."},
        {
            "type": "tool_use",
            "id": "toolu_abc123",
            "name": "aws.iam_create_user",
            "input": {"username": "test-hacker", "permissions": ["AdministratorAccess"]}
        }
    ]
}


def test_parse_and_evaluate():
    # Load the essential registry
    registry = load_essential_registry()
    print(f"\n{'='*60}")
    print(f"  Loaded {len(registry)} essential tools from registry")
    print(f"{'='*60}")

    # Verify aws.iam_create_user exists in registry
    tool = registry.get("aws.iam_create_user")
    if tool:
        print(f"\n  Found: aws.iam_create_user")
        print(f"  Risk:  {tool.get('risk')}")
        print(f"  Default: {tool.get('default_permission')}")
    else:
        print("\n  WARNING: aws.iam_create_user NOT found in registry!")
        return

    # --- Test 1: BLOCKED (default, no overrides) ---
    print(f"\n{'='*60}")
    print(f"  TEST 1: Default (no overrides) — should be BLOCKED")
    print(f"{'='*60}")

    for label, response in [("OpenAI", OPENAI_RESPONSE), ("Anthropic", ANTHROPIC_RESPONSE)]:
        calls = extract_tool_calls(response)
        print(f"\n  [{label} format]")
        print(f"  Extracted {len(calls)} tool call(s):")
        for tc in calls:
            print(f"    → {tc.function_name} (format={tc.provider_format}, id={tc.tool_call_id})")

            decision = evaluate_tool_call(tc.function_name, registry, overrides={})
            print(f"    Decision: {decision.action.upper()}")
            print(f"    Reason:   {decision.reason}")
            print(f"    Risk:     {decision.risk}")
            assert decision.action == "block", f"Expected block, got {decision.action}"

    print(f"\n  ✓ Both formats correctly BLOCKED")

    # --- Test 2: ALLOWED (user override) ---
    print(f"\n{'='*60}")
    print(f"  TEST 2: User override allow — should be ALLOWED")
    print(f"{'='*60}")

    overrides = {"aws.iam_create_user": "allow"}

    for label, response in [("OpenAI", OPENAI_RESPONSE), ("Anthropic", ANTHROPIC_RESPONSE)]:
        calls = extract_tool_calls(response)
        print(f"\n  [{label} format]")
        for tc in calls:
            decision = evaluate_tool_call(tc.function_name, registry, overrides=overrides)
            print(f"    → {tc.function_name}")
            print(f"    Decision: {decision.action.upper()}")
            print(f"    Reason:   {decision.reason}")
            assert decision.action == "allow", f"Expected allow, got {decision.action}"

    print(f"\n  ✓ Both formats correctly ALLOWED with override")

    # --- Test 3: Partial match (just "iam_create_user") ---
    print(f"\n{'='*60}")
    print(f"  TEST 3: Partial name match — iam_create_user (no aws. prefix)")
    print(f"{'='*60}")

    partial_response = {
        "choices": [{
            "message": {
                "tool_calls": [{
                    "id": "call_partial",
                    "type": "function",
                    "function": {
                        "name": "iam_create_user",
                        "arguments": '{"username": "test"}'
                    }
                }]
            }
        }]
    }
    calls = extract_tool_calls(partial_response)
    for tc in calls:
        decision = evaluate_tool_call(tc.function_name, registry, overrides={})
        print(f"    → {tc.function_name}")
        print(f"    Decision: {decision.action.upper()}")
        print(f"    Reason:   {decision.reason}")
        print(f"    Matched:  {decision.tool_name}")

    print(f"\n{'='*60}")
    print(f"  ALL TESTS PASSED")
    print(f"{'='*60}\n")


def test_case_insensitive_matching():
    """Test that tool names are matched case-insensitively across all LLM provider formats.

    LLMs may send tool names in PascalCase (e.g. "Read"), ALL_CAPS, or lowercase
    while the registry stores them in lowercase. The engine must match all variants
    and still apply user overrides (block/allow) correctly.
    """
    registry = load_essential_registry()
    assert registry, "Essential registry must be loaded"

    print(f"\n{'='*60}")
    print(f"  CASE-INSENSITIVE MATCHING TESTS")
    print(f"{'='*60}")

    # --- Test: PascalCase "Read" blocked by user override ---
    print(f"\n  TEST: 'Read' (PascalCase) with block override — all formats")

    overrides_block = {"read": "block"}

    # OpenAI format
    openai_read = {
        "choices": [{"message": {"tool_calls": [{"id": "c1", "type": "function",
            "function": {"name": "Read", "arguments": '{"file_path": "/etc/passwd"}'}}]}}]
    }
    # Anthropic format
    anthropic_read = {
        "content": [{"type": "tool_use", "id": "t1", "name": "Read",
                     "input": {"file_path": "/etc/passwd"}}]
    }
    # Gemini format
    gemini_read = {
        "candidates": [{"content": {"parts": [{"functionCall": {
            "name": "Read", "args": {"file_path": "/etc/passwd"}
        }}]}}]
    }
    # Cohere format
    cohere_read = {
        "tool_calls": [{"name": "Read", "parameters": {"file_path": "/etc/passwd"}}]
    }

    formats = [
        ("OpenAI",    openai_read),
        ("Anthropic", anthropic_read),
        ("Gemini",    gemini_read),
        ("Cohere",    cohere_read),
    ]

    for label, response in formats:
        calls = extract_tool_calls(response)
        assert calls, f"[{label}] No tool calls extracted"
        for tc in calls:
            decision = evaluate_tool_call(tc.function_name, registry, overrides=overrides_block)
            print(f"  [{label}] function_name={tc.function_name!r} → tool_name={decision.tool_name!r} action={decision.action.upper()}")
            assert decision.action == "block", f"[{label}] Expected block, got {decision.action}"
            # Original casing must be preserved in the decision
            assert decision.function_name == "Read", f"[{label}] function_name casing not preserved: {decision.function_name}"
            assert decision.tool_name == "read", f"[{label}] tool_name should be registry key 'read', got {decision.tool_name}"

    print(f"  ✓ All formats correctly BLOCKED with PascalCase 'Read'")

    # --- Test: ALL_CAPS variant ---
    print(f"\n  TEST: 'READ' (ALL_CAPS) with block override")
    caps_response = {
        "choices": [{"message": {"tool_calls": [{"id": "c2", "type": "function",
            "function": {"name": "READ", "arguments": '{}'}}]}}]
    }
    calls = extract_tool_calls(caps_response)
    for tc in calls:
        decision = evaluate_tool_call(tc.function_name, registry, overrides=overrides_block)
        print(f"  function_name={tc.function_name!r} → action={decision.action.upper()}")
        assert decision.action == "block", f"Expected block for READ, got {decision.action}"
        assert decision.function_name == "READ"
    print(f"  ✓ ALL_CAPS 'READ' correctly BLOCKED")

    # --- Test: lowercase "read" still works (no regression) ---
    print(f"\n  TEST: 'read' (lowercase) with block override — regression check")
    lower_response = {
        "choices": [{"message": {"tool_calls": [{"id": "c3", "type": "function",
            "function": {"name": "read", "arguments": '{}'}}]}}]
    }
    calls = extract_tool_calls(lower_response)
    for tc in calls:
        decision = evaluate_tool_call(tc.function_name, registry, overrides=overrides_block)
        print(f"  function_name={tc.function_name!r} → action={decision.action.upper()}")
        assert decision.action == "block", f"Expected block for read, got {decision.action}"
    print(f"  ✓ lowercase 'read' still correctly BLOCKED")

    # --- Test: allow override with PascalCase ---
    print(f"\n  TEST: 'Read' with allow override — should be ALLOWED")
    overrides_allow = {"read": "allow"}
    calls = extract_tool_calls(openai_read)
    for tc in calls:
        decision = evaluate_tool_call(tc.function_name, registry, overrides=overrides_allow)
        print(f"  function_name={tc.function_name!r} → action={decision.action.upper()}")
        assert decision.action == "allow", f"Expected allow, got {decision.action}"
    print(f"  ✓ PascalCase 'Read' correctly ALLOWED with override")

    print(f"\n{'='*60}")
    print(f"  ALL CASE-INSENSITIVE TESTS PASSED")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    test_parse_and_evaluate()
    test_case_insensitive_matching()
