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


if __name__ == "__main__":
    test_parse_and_evaluate()
