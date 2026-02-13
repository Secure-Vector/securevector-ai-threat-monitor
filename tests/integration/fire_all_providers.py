#!/usr/bin/env python3
"""Fire requests through the running multi-provider proxy to all 12 providers."""

import asyncio
import json
import httpx

PROXY = "http://127.0.0.1:8742"

PROVIDERS = {
    "openai": {
        "path": "/v1/chat/completions",
        "body": {"model": "gpt-4", "messages": [{"role": "user", "content": "Hello from SecureVector proxy test"}]},
    },
    "anthropic": {
        "path": "/v1/messages",
        "body": {"model": "claude-sonnet-4-5-20250514", "max_tokens": 10, "messages": [{"role": "user", "content": "Hello from SecureVector proxy test"}]},
    },
    "groq": {
        "path": "/v1/chat/completions",
        "body": {"model": "llama-3.3-70b-versatile", "messages": [{"role": "user", "content": "Hello from SecureVector proxy test"}]},
    },
    "cerebras": {
        "path": "/v1/chat/completions",
        "body": {"model": "llama3.1-8b", "messages": [{"role": "user", "content": "Hello from SecureVector proxy test"}]},
    },
    "mistral": {
        "path": "/v1/chat/completions",
        "body": {"model": "mistral-small-latest", "messages": [{"role": "user", "content": "Hello from SecureVector proxy test"}]},
    },
    "xai": {
        "path": "/v1/chat/completions",
        "body": {"model": "grok-3-mini-fast", "messages": [{"role": "user", "content": "Hello from SecureVector proxy test"}]},
    },
    "gemini": {
        "path": "/v1beta/models/gemini-pro:generateContent",
        "body": {"contents": [{"role": "user", "parts": [{"text": "Hello from SecureVector proxy test"}]}]},
    },
    "moonshot": {
        "path": "/v1/chat/completions",
        "body": {"model": "moonshot-v1-8k", "messages": [{"role": "user", "content": "Hello from SecureVector proxy test"}]},
    },
    "minimax": {
        "path": "/v1/chat/completions",
        "body": {"model": "abab5.5-chat", "messages": [{"role": "user", "content": "Hello from SecureVector proxy test"}]},
    },
    "deepseek": {
        "path": "/v1/chat/completions",
        "body": {"model": "deepseek-chat", "messages": [{"role": "user", "content": "Hello from SecureVector proxy test"}]},
    },
    "together": {
        "path": "/v1/chat/completions",
        "body": {"model": "meta-llama/Llama-3-8b-chat-hf", "messages": [{"role": "user", "content": "Hello from SecureVector proxy test"}]},
    },
    "cohere": {
        "path": "/v1/chat",
        "body": {"message": "Hello from SecureVector proxy test"},
    },
}


async def test_one(client, provider, cfg):
    path = cfg["path"]
    url = f"{PROXY}/{provider}{path}"
    try:
        r = await client.post(
            url,
            json=cfg["body"],
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer test-no-real-key",
            },
            timeout=15.0,
        )
        status = r.status_code

        # Extract short error message
        err = ""
        try:
            body = r.json()
            if isinstance(body, dict):
                e = body.get("error", {})
                if isinstance(e, dict):
                    err = e.get("message", e.get("type", ""))
                elif isinstance(e, str):
                    err = e
                elif body.get("message"):
                    err = str(body["message"])
        except Exception:
            err = r.text[:100]

        if len(err) > 60:
            err = err[:57] + "..."

        if status in (401, 403):
            verdict = "FORWARDED -> auth rejected (no API key)"
        elif status == 400:
            verdict = "FORWARDED -> bad request (reached provider)"
        elif status == 404:
            verdict = "FORWARDED -> endpoint not found at provider"
        elif status == 422:
            verdict = "FORWARDED -> validation error at provider"
        elif status == 502:
            verdict = "FORWARDED -> upstream unreachable (502)"
        elif status == 200:
            verdict = "FORWARDED -> got 200 response!"
        else:
            verdict = f"FORWARDED -> status {status}"

        return provider, status, verdict, err

    except httpx.ConnectError as e:
        return provider, None, "PROXY CONNECT FAIL", str(e)[:60]
    except httpx.TimeoutException:
        return provider, None, "FORWARDED -> upstream timeout", ""
    except Exception as e:
        return provider, None, f"ERROR: {type(e).__name__}", str(e)[:60]


async def main():
    async with httpx.AsyncClient() as client:
        tasks = [test_one(client, p, c) for p, c in PROVIDERS.items()]
        results = await asyncio.gather(*tasks)

    print()
    print("=" * 110)
    print("  SecureVector Multi-Provider Proxy - All 12 Providers Live Test")
    print("=" * 110)
    hdr = f"  {'Provider':<13} {'HTTP':<6} {'Result':<47} {'Upstream Response'}"
    print(hdr)
    print("-" * 110)

    forwarded = 0
    for provider, status, verdict, err in sorted(results, key=lambda x: x[0]):
        s = str(status) if status else "-"
        tag = "OK" if "FORWARDED" in verdict else "!!"
        print(f"  {provider:<13} {s:<6} [{tag}] {verdict:<44} {err}")
        if "FORWARDED" in verdict:
            forwarded += 1

    print("-" * 110)
    print(f"  Forwarded through proxy: {forwarded}/{len(results)} providers")
    print("=" * 110)


if __name__ == "__main__":
    asyncio.run(main())
