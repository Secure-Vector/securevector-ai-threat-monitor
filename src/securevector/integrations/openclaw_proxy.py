#!/usr/bin/env python3
"""
SecureVector OpenClaw Proxy

A local WebSocket proxy that scans all messages between users and OpenClaw
for prompt injection, jailbreaks, and other security threats.

Usage:
    python -m securevector.integrations.openclaw_proxy

    # Or with custom ports:
    python -m securevector.integrations.openclaw_proxy --port 8080 --openclaw-port 18789

Then connect your client to ws://localhost:8080 instead of OpenClaw directly.
"""

import argparse
import asyncio
import json
import sys
from typing import Optional

try:
    import websockets
    import httpx
except ImportError:
    print("Missing dependencies. Install with:")
    print("  pip install websockets httpx")
    sys.exit(1)


class SecureVectorProxy:
    MAX_CONNECTION_FAILURES = 10

    def __init__(
        self,
        proxy_port: int = 18789,
        openclaw_host: str = "127.0.0.1",
        openclaw_port: int = 18790,
        securevector_host: str = "127.0.0.1",
        securevector_port: int = 8741,
        scan_outgoing: bool = True,
        block_threats: bool = False,
        verbose: bool = False,
    ):
        self.proxy_port = proxy_port
        self.openclaw_host = openclaw_host
        self.openclaw_port = openclaw_port
        self.openclaw_url = f"ws://{openclaw_host}:{openclaw_port}"
        self.securevector_url = f"http://{securevector_host}:{securevector_port}/analyze"
        self.scan_outgoing = scan_outgoing
        self.block_threats = block_threats
        self.verbose = verbose
        self.stats = {"scanned": 0, "blocked": 0, "passed": 0}
        self._http_client: Optional[httpx.AsyncClient] = None
        self._connection_failures = 0
        self._should_exit = False
        self._output_scan_enabled: Optional[bool] = None
        self._output_scan_checked_at: float = 0

    def _truncate(self, text: str, max_len: int = 200) -> str:
        """Truncate text for logging."""
        if len(text) <= max_len:
            return text
        return text[:max_len] + f"... ({len(text)} chars)"

    async def get_http_client(self) -> httpx.AsyncClient:
        """Get or create shared HTTP client."""
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(
                timeout=15.0,  # Increased for LLM review
                headers={"User-Agent": "SecureVector-Proxy/1.0 (OpenClaw)"}
            )
        return self._http_client

    async def check_settings(self) -> dict:
        """Check SecureVector settings (cached for 10s)."""
        import time
        now = time.time()
        # Cache for 10 seconds to avoid excessive API calls
        if self._output_scan_enabled is not None and (now - self._output_scan_checked_at) < 10:
            return {
                "scan_llm_responses": self._output_scan_enabled,
                "block_threats": getattr(self, '_block_threats_enabled', self.block_threats),
            }

        try:
            client = await self.get_http_client()
            settings_url = self.securevector_url.replace("/analyze", "/api/settings")
            response = await client.get(settings_url)
            if response.status_code == 200:
                settings = response.json()
                self._output_scan_enabled = settings.get("scan_llm_responses", True)
                self._block_threats_enabled = settings.get("block_threats", False)
                self._output_scan_checked_at = now
                return {
                    "scan_llm_responses": self._output_scan_enabled,
                    "block_threats": self._block_threats_enabled,
                }
            return {"scan_llm_responses": True, "block_threats": self.block_threats}
        except Exception as e:
            if self.verbose:
                print(f"[proxy] Could not check settings: {e}")
            return {"scan_llm_responses": True, "block_threats": self.block_threats}

    async def check_output_scan_enabled(self) -> bool:
        """Check if output scanning is enabled in SecureVector settings."""
        settings = await self.check_settings()
        return settings.get("scan_llm_responses", True)

    async def check_block_mode_enabled(self) -> bool:
        """Check if block mode is enabled in SecureVector settings."""
        settings = await self.check_settings()
        return settings.get("block_threats", False)

    async def _scan_output(self, text: str) -> bool:
        """Scan output for threats and store for logging.

        Note: Redaction is handled at the storage layer (analyze.py), not here.
        This method only detects threats and logs them - messages are always
        forwarded to the client unchanged (preserving streaming UX).

        Returns:
            True if threat was detected, False otherwise
        """
        if not text or len(text) < 20:
            return False

        # Check if output scanning is enabled
        output_scan_enabled = await self.check_output_scan_enabled()
        if not output_scan_enabled:
            return False

        print(f"[proxy] 🔍 Scanning complete output ({len(text)} chars): {self._truncate(text, 80)}")

        # Scan and store - redaction happens at storage layer (analyze.py)
        result = await self.scan_message(text, is_llm_response=True, store=True, scan_type="output")

        if result.get("is_threat"):
            threat_type = result.get("threat_type", "unknown")
            risk_score = result.get("risk_score", 0)
            print(f"[proxy] ⚠️  OUTPUT LEAKAGE DETECTED: {threat_type} (risk: {risk_score}%)")
            print(f"[proxy] 🔒 Secrets will be redacted in storage (analyze.py)")
            return True
        else:
            print(f"[proxy] ✓ Output scanned - no threat")
            return False

    async def scan_message(self, text: str, is_llm_response: bool = False, store: bool = True, scan_type: str = "input") -> dict:
        """Scan a message with SecureVector API.

        Args:
            text: The text content to analyze
            is_llm_response: True when scanning LLM output (checks for leaks, PII)
            store: Whether to store the result (False for quick scans that don't need logging)
            scan_type: "input" or "output" to mark the scan direction
        """
        try:
            client = await self.get_http_client()
            response = await client.post(
                self.securevector_url,
                json={
                    "text": text,
                    "llm_response": is_llm_response,
                    "metadata": {"source": "openclaw-proxy", "store": store, "scan_type": scan_type}
                }
            )
            if response.status_code == 200:
                return response.json()
            else:
                print(f"[proxy] SecureVector returned {response.status_code}")
                return {"is_threat": False}
        except Exception as e:
            print(f"[proxy] SecureVector error: {e}")
            return {"is_threat": False}

    async def handle_client(self, client_ws):
        """Handle a client connection by proxying to OpenClaw."""
        client_addr = client_ws.remote_address
        print(f"[proxy] Client connected: {client_addr}")

        openclaw_ws = None
        tasks = []

        try:
            # Connect to OpenClaw with timeout
            try:
                openclaw_ws = await asyncio.wait_for(
                    websockets.connect(self.openclaw_url),
                    timeout=10.0
                )
                # Reset failure counter on successful connection
                self._connection_failures = 0
                print(f"[proxy] Connected to OpenClaw: {self.openclaw_url}")
            except asyncio.TimeoutError:
                self._connection_failures += 1
                print(f"[proxy] Timeout connecting to OpenClaw at {self.openclaw_url} (attempt {self._connection_failures}/{self.MAX_CONNECTION_FAILURES})")
                await client_ws.close(1011, "OpenClaw connection timeout")
                self._check_exit_condition()
                return
            except Exception as e:
                self._connection_failures += 1
                print(f"[proxy] Failed to connect to OpenClaw: {e} (attempt {self._connection_failures}/{self.MAX_CONNECTION_FAILURES})")
                await client_ws.close(1011, f"OpenClaw connection failed: {e}")
                self._check_exit_condition()
                return

            async def client_to_openclaw():
                """Forward messages from client to OpenClaw after scanning."""
                try:
                    async for message in client_ws:
                        # Log incoming message
                        if self.verbose:
                            print(f"[proxy] → USER->OPENCLAW: {self._truncate(message)}")

                        # Parse message to check if it's a chat/prompt message
                        text_to_scan = None
                        try:
                            data = json.loads(message)
                            msg_type = data.get("type", "")
                            method = data.get("method", "")
                            params = data.get("params", {})

                            # Extract message content from chat/message methods
                            # Covers: chat.send, agent.chat, sessions.send (agent-to-agent), etc.
                            scan_methods = (
                                "chat.send", "chat.message",
                                "agent.chat", "agent.run", "agent.send", "agent.message",
                                "agent.delegate", "agent.handoff", "agent.invoke",
                                "message.send", "message.create",
                                "sessions.send", "sessions_send", "session.send",  # Agent-to-agent
                                "task.run", "task.execute",
                            )
                            if method in scan_methods or "chat" in method or "message" in method or "send" in method or "sessions" in method:
                                text_to_scan = (
                                    params.get("message") or
                                    params.get("prompt") or
                                    params.get("content") or
                                    params.get("text") or
                                    params.get("input") or
                                    params.get("query") or
                                    params.get("task")
                                )
                            # Direct text fields (other protocols)
                            elif msg_type in ("message", "chat", "prompt"):
                                text_to_scan = (
                                    data.get("text") or
                                    data.get("message") or
                                    data.get("content") or
                                    data.get("prompt")
                                )

                            if self.verbose and text_to_scan:
                                print(f"[proxy] 🔍 Found prompt to scan: {self._truncate(text_to_scan, 50)}")

                        except (json.JSONDecodeError, TypeError):
                            # Non-JSON message, scan the whole thing if it looks like text
                            if len(message) > 10 and not message.startswith('{'):
                                text_to_scan = message

                        # Scan if we found scannable content
                        if text_to_scan and isinstance(text_to_scan, str) and len(text_to_scan) > 3:
                            self.stats["scanned"] += 1
                            result = await self.scan_message(text_to_scan, is_llm_response=False)

                            if result.get("is_threat"):
                                threat_type = result.get("threat_type", "unknown")
                                risk_score = result.get("risk_score", 0)
                                print(f"[proxy] ⚠️  THREAT DETECTED: {threat_type} (risk: {risk_score})")

                                # Check if blocking is enabled (UI setting is authoritative)
                                # Note: Block mode only applies to INPUT - output scanning never blocks
                                block_enabled = await self.check_block_mode_enabled()
                                if block_enabled:
                                    self.stats["blocked"] += 1
                                    # Try to get original request ID for proper response
                                    req_id = None
                                    try:
                                        req_id = data.get("id")
                                    except:
                                        pass

                                    # Send error response in OpenClaw format
                                    error_response = json.dumps({
                                        "type": "res",
                                        "id": req_id,
                                        "ok": False,
                                        "error": {
                                            "code": "BLOCKED_BY_SECUREVECTOR",
                                            "message": f"⚠️ Security Alert: Request blocked by SecureVector\n\nThreat Type: {threat_type}\nRisk Score: {risk_score}%\n\nThis message was flagged as potentially malicious and was not sent to the AI."
                                        }
                                    })
                                    await client_ws.send(error_response)
                                    continue
                                else:
                                    # Threat detected but block mode OFF - log and forward
                                    self.stats["passed"] += 1
                                    print(f"[proxy] ⚠️  Threat logged (block mode OFF) - forwarding message")
                            else:
                                self.stats["passed"] += 1
                                print(f"[proxy] ✓ Prompt scanned (total: {self.stats['scanned']})")

                        # Forward to OpenClaw
                        await openclaw_ws.send(message)
                except websockets.exceptions.ConnectionClosed:
                    pass

            async def openclaw_to_client():
                """Forward messages from OpenClaw to client, with optional blocking.

                If block mode is OFF: Forward immediately (streaming UX), scan at end.
                If block mode is ON: Buffer response, scan, then forward or block.
                """
                accumulated_text = ""
                buffered_messages = []
                block_mode = await self.check_block_mode_enabled()
                scan_timeout = 10.0  # Max seconds to wait for scan

                try:
                    async for message in openclaw_ws:
                        if self.verbose:
                            print(f"[proxy] ← OPENCLAW->USER: {self._truncate(message)}")

                        # If block mode OFF, forward immediately (preserve streaming)
                        if not block_mode:
                            await client_ws.send(message)

                        # Buffer message if block mode is ON
                        if block_mode:
                            buffered_messages.append(message)

                        # Accumulate text for scanning
                        if self.scan_outgoing:
                            try:
                                data = json.loads(message)
                                msg_type = data.get("type", "")
                                event = data.get("event", "")

                                # Debug: log event types we're seeing
                                if self.verbose:
                                    print(f"[proxy] Event: type={msg_type}, event={event}")

                                # Extract text from streaming agent events
                                if msg_type == "event" and event == "agent":
                                    payload = data.get("payload", {})
                                    stream_type = payload.get("stream", "")

                                    if stream_type == "assistant":
                                        payload_data = payload.get("data", {})
                                        if isinstance(payload_data, dict):
                                            chunk_text = payload_data.get("text", "")
                                            if chunk_text:
                                                accumulated_text = chunk_text
                                                if self.verbose:
                                                    print(f"[proxy] Accumulated agent text: {len(accumulated_text)} chars")

                                # Extract text from chat events
                                elif msg_type == "event" and event == "chat":
                                    payload = data.get("payload", {})
                                    state = payload.get("state", "")
                                    msg = payload.get("message", {})

                                    if isinstance(msg, dict):
                                        msg_content = msg.get("content")
                                        if isinstance(msg_content, str):
                                            accumulated_text = msg_content
                                        elif isinstance(msg_content, list) and msg_content:
                                            for item in msg_content:
                                                if isinstance(item, dict) and item.get("type") == "text":
                                                    accumulated_text = item.get("text", "")
                                                    break
                                        if accumulated_text and self.verbose:
                                            print(f"[proxy] Accumulated chat text: {len(accumulated_text)} chars")

                                    # Scan when response is complete (state="final")
                                    if state == "final" and accumulated_text and len(accumulated_text) > 20:
                                        print(f"[proxy] 📤 Response complete, scanning {len(accumulated_text)} chars...")

                                        # Re-check block mode (settings may have changed)
                                        block_mode = await self.check_block_mode_enabled()

                                        if block_mode:
                                            # Block mode ON: scan with timeout, then decide to forward or block
                                            try:
                                                result = await asyncio.wait_for(
                                                    self.scan_message(accumulated_text, is_llm_response=True, store=True, scan_type="output"),
                                                    timeout=scan_timeout
                                                )
                                                if result.get("is_threat"):
                                                    threat_type = result.get("threat_type", "unknown")
                                                    risk_score = result.get("risk_score", 0)
                                                    print(f"[proxy] ⚠️  OUTPUT BLOCKED: {threat_type} (risk: {risk_score}%)")
                                                    self.stats["blocked"] += 1
                                                    # Send blocked message instead of buffered response
                                                    error_response = json.dumps({
                                                        "type": "event",
                                                        "event": "chat",
                                                        "payload": {
                                                            "state": "final",
                                                            "message": {
                                                                "role": "assistant",
                                                                "content": f"⚠️ Response blocked by SecureVector\n\nThreat Type: {threat_type}\nRisk Score: {risk_score}%\n\nThe AI response contained potentially sensitive data and was blocked."
                                                            }
                                                        }
                                                    })
                                                    await client_ws.send(error_response)
                                                    buffered_messages = []  # Clear buffer
                                                else:
                                                    # No threat, forward all buffered messages
                                                    print(f"[proxy] ✓ Output scanned - forwarding {len(buffered_messages)} messages")
                                                    for msg in buffered_messages:
                                                        await client_ws.send(msg)
                                                    buffered_messages = []
                                            except asyncio.TimeoutError:
                                                # Scan timed out, forward messages but log warning
                                                print(f"[proxy] ⚠️ Scan timed out after {scan_timeout}s, forwarding without block")
                                                for msg in buffered_messages:
                                                    await client_ws.send(msg)
                                                buffered_messages = []
                                        else:
                                            # Block mode OFF: scan in background
                                            asyncio.create_task(self._scan_output(accumulated_text))

                                        accumulated_text = ""  # Reset for next response

                            except (json.JSONDecodeError, TypeError) as e:
                                if self.verbose:
                                    print(f"[proxy] JSON parse error: {e}")

                except websockets.exceptions.ConnectionClosed:
                    pass
                finally:
                    # Handle remaining buffered messages on disconnect
                    if block_mode and buffered_messages:
                        # Forward remaining messages if no final state was reached
                        for msg in buffered_messages:
                            try:
                                await client_ws.send(msg)
                            except:
                                pass
                    # Scan any remaining text if connection closes mid-response
                    if self.scan_outgoing and accumulated_text and len(accumulated_text) > 20:
                        print(f"[proxy] 📤 Connection closed, scanning remaining {len(accumulated_text)} chars...")
                        await self._scan_output(accumulated_text)

            # Run both directions concurrently
            tasks = [
                asyncio.create_task(client_to_openclaw()),
                asyncio.create_task(openclaw_to_client())
            ]

            # Wait for either to complete (one closes = both should stop)
            _done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)

            # Cancel pending tasks
            for task in pending:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        except websockets.exceptions.ConnectionClosed as e:
            print(f"[proxy] Connection closed: {e}")
        except Exception as e:
            print(f"[proxy] Error: {e}")
        finally:
            # Clean up
            if openclaw_ws:
                try:
                    await openclaw_ws.close()
                except:
                    pass

            # Cancel any remaining tasks
            for task in tasks:
                if not task.done():
                    task.cancel()

            print(f"[proxy] Client disconnected: {client_addr}")
            print(f"[proxy] Stats - Scanned: {self.stats['scanned']}, Blocked: {self.stats['blocked']}, Passed: {self.stats['passed']}")

    def _check_exit_condition(self):
        """Check if we should exit due to repeated connection failures."""
        if self._connection_failures >= self.MAX_CONNECTION_FAILURES:
            print(f"\n[proxy] ❌ FATAL: Failed to connect to OpenClaw {self.MAX_CONNECTION_FAILURES} times consecutively.")
            print(f"[proxy] Please start OpenClaw on port {self.openclaw_port}:")
            print(f"[proxy]     openclaw gateway --port {self.openclaw_port}")
            print(f"[proxy] Exiting...")
            self._should_exit = True

    async def run(self):
        """Start the proxy server."""
        print(f"""
╔═══════════════════════════════════════════════════════════════╗
║                    SecureVector Proxy                         ║
╠═══════════════════════════════════════════════════════════════╣
║  Proxy listening on:     ws://127.0.0.1:{self.proxy_port:<5}                 ║
║  Forwarding to:          {self.openclaw_url:<25}        ║
║  SecureVector API:       {self.securevector_url:<25}  ║
║  Scan outgoing:          {str(self.scan_outgoing):<5}                            ║
║  Block threats:          {str(self.block_threats):<5}                            ║
║  Verbose:                {str(self.verbose):<5}                            ║
╠═══════════════════════════════════════════════════════════════╣
║  Connect your client to ws://127.0.0.1:{self.proxy_port:<5} instead of      ║
║  connecting directly to the target.                           ║
╚═══════════════════════════════════════════════════════════════╝
""")

        # Suppress websocket handshake errors for non-WS requests
        import logging
        logging.getLogger("websockets").setLevel(logging.CRITICAL)
        logging.getLogger("websockets.server").setLevel(logging.CRITICAL)

        async with websockets.serve(
            self.handle_client,
            "127.0.0.1",
            self.proxy_port,
            ping_interval=30,
            ping_timeout=10,
        ):
            # Run until exit flag is set
            while not self._should_exit:
                await asyncio.sleep(1)

            if self._should_exit:
                print("[proxy] Shutting down due to connection failures...")

    async def cleanup(self):
        """Clean up resources."""
        if self._http_client:
            await self._http_client.aclose()


def main():
    parser = argparse.ArgumentParser(
        description="SecureVector proxy for OpenClaw - scans all messages for security threats"
    )
    parser.add_argument(
        "--port", "-p",
        type=int,
        default=18789,
        help="Proxy listen port (default: 18789)"
    )
    parser.add_argument(
        "--openclaw-host",
        type=str,
        default="127.0.0.1",
        help="OpenClaw host (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--openclaw-port",
        type=int,
        default=18790,
        help="OpenClaw port (default: 18790)"
    )
    parser.add_argument(
        "--securevector-host",
        type=str,
        default="127.0.0.1",
        help="SecureVector host (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--securevector-port",
        type=int,
        default=8741,
        help="SecureVector port (default: 8741)"
    )
    parser.add_argument(
        "--no-scan-outgoing",
        action="store_true",
        help="Don't scan outgoing messages (LLM responses)"
    )
    parser.add_argument(
        "--no-block",
        action="store_true",
        help="Log threats but don't block them"
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Log all messages passing through the proxy"
    )

    args = parser.parse_args()

    proxy = SecureVectorProxy(
        proxy_port=args.port,
        openclaw_host=args.openclaw_host,
        openclaw_port=args.openclaw_port,
        securevector_host=args.securevector_host,
        securevector_port=args.securevector_port,
        scan_outgoing=not args.no_scan_outgoing,
        block_threats=not args.no_block,
        verbose=args.verbose,
    )

    try:
        asyncio.run(proxy.run())
    except KeyboardInterrupt:
        print("\n[proxy] Shutting down...")
    finally:
        asyncio.run(proxy.cleanup())


if __name__ == "__main__":
    main()
