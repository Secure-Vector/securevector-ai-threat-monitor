"""
Enhanced Command Line Interface for AI Threat Monitor SDK with advanced features.

This module provides comprehensive CLI tools for testing, development, debugging,
and production workflows with the SecureVector AI Threat Monitor SDK.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import argparse
import asyncio
import csv
import json
import logging
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, TextIO

from .utils.exceptions import APIError, ConfigurationError, SecurityException
from .utils.logger import get_logger
from .utils.retry import API_RETRY_CONFIG, RetryConfig
from .utils.telemetry import TelemetryCollector, get_telemetry_collector

from .async_client import AsyncSecureVectorClient
from .client import SecureVectorClient
from .models.config_models import OperationMode, SDKConfig
from .models.policy_models import SecurityPolicy
from .streaming import StreamingAnalyzer, analyze_large_text
from .testing import MockBehavior, MockSecureVectorClient, create_test_prompts


class EnhancedCLI:
    """Enhanced CLI with advanced features for development and testing"""

    def __init__(self):
        self.logger = get_logger(__name__)
        self.telemetry = get_telemetry_collector()

    def create_parser(self) -> argparse.ArgumentParser:
        """Create enhanced argument parser"""
        parser = argparse.ArgumentParser(
            prog="sv-enhanced",
            description="SecureVector AI Threat Monitor - Enhanced CLI for Development",
            formatter_class=argparse.RawDescriptionHelpFormatter,
            epilog=self._get_help_text(),
        )

        # Global options
        parser.add_argument(
            "--version", action="version", version="SecureVector Enhanced CLI 1.0.0"
        )
        parser.add_argument("--debug", action="store_true", help="Enable debug mode")
        parser.add_argument("--telemetry", action="store_true", help="Enable telemetry collection")
        parser.add_argument(
            "--output",
            "-o",
            choices=["json", "yaml", "csv", "table"],
            default="table",
            help="Output format",
        )
        parser.add_argument("--config-file", type=str, help="Configuration file path")

        # Create subparsers for commands
        subparsers = parser.add_subparsers(dest="command", help="Available commands")

        # Analysis commands
        self._add_analysis_commands(subparsers)

        # Testing commands
        self._add_testing_commands(subparsers)

        # Development commands
        self._add_development_commands(subparsers)

        # Streaming commands
        self._add_streaming_commands(subparsers)

        # Benchmarking commands
        self._add_benchmark_commands(subparsers)

        # Debugging commands
        self._add_debug_commands(subparsers)

        return parser

    def _add_analysis_commands(self, subparsers):
        """Add analysis-related commands"""
        # Analyze command
        analyze_parser = subparsers.add_parser("analyze", help="Analyze prompts for threats")
        analyze_parser.add_argument("prompt", nargs="?", help="Prompt to analyze")
        analyze_parser.add_argument("--file", "-f", type=str, help="File containing prompts")
        analyze_parser.add_argument(
            "--mode",
            choices=["local", "api", "hybrid", "auto"],
            default="auto",
            help="Analysis mode",
        )
        analyze_parser.add_argument("--api-key", type=str, help="API key for enhanced analysis")
        analyze_parser.add_argument("--batch", action="store_true", help="Process as batch")
        analyze_parser.add_argument(
            "--async", dest="use_async", action="store_true", help="Use async processing"
        )
        analyze_parser.add_argument(
            "--concurrent", type=int, default=5, help="Max concurrent requests for async"
        )

        # Interactive analyze command
        interactive_parser = subparsers.add_parser(
            "interactive", help="Interactive analysis session"
        )
        interactive_parser.add_argument(
            "--mode",
            choices=["local", "api", "hybrid", "auto"],
            default="auto",
            help="Analysis mode",
        )
        interactive_parser.add_argument("--api-key", type=str, help="API key")

    def _add_testing_commands(self, subparsers):
        """Add testing-related commands"""
        # Test command
        test_parser = subparsers.add_parser("test", help="Run comprehensive tests")
        test_parser.add_argument(
            "--type",
            choices=["unit", "integration", "performance", "all"],
            default="all",
            help="Test type to run",
        )
        test_parser.add_argument(
            "--scenarios",
            nargs="+",
            choices=["safe", "threat", "mixed", "prompt_injection", "data_exfiltration"],
            default=["mixed"],
            help="Test scenarios",
        )
        test_parser.add_argument("--count", type=int, default=100, help="Number of test prompts")
        test_parser.add_argument("--mock", action="store_true", help="Use mock client")

        # Generate test data
        generate_parser = subparsers.add_parser("generate", help="Generate test data")
        generate_parser.add_argument("type", choices=["prompts", "results", "config"])
        generate_parser.add_argument(
            "--scenario", choices=["safe", "threat", "mixed"], default="mixed"
        )
        generate_parser.add_argument("--count", type=int, default=10)
        generate_parser.add_argument("--output-file", type=str, help="Output file path")

        # Mock server
        mock_parser = subparsers.add_parser("mock", help="Run mock server for testing")
        mock_parser.add_argument("--port", type=int, default=8080, help="Server port")
        mock_parser.add_argument(
            "--threat-rate", type=float, default=0.3, help="Simulated threat detection rate"
        )

    def _add_development_commands(self, subparsers):
        """Add development-related commands"""
        # Development server
        dev_parser = subparsers.add_parser("dev", help="Development utilities")
        dev_subparsers = dev_parser.add_subparsers(dest="dev_command")

        # Hot reload
        reload_parser = dev_subparsers.add_parser("reload", help="Hot reload rules")
        reload_parser.add_argument("--rules-dir", type=str, help="Rules directory to watch")

        # Profile
        profile_parser = dev_subparsers.add_parser("profile", help="Profile performance")
        profile_parser.add_argument("prompt", help="Prompt to profile")
        profile_parser.add_argument("--iterations", type=int, default=100)
        profile_parser.add_argument("--mode", choices=["local", "api", "hybrid"], default="local")

        # Validate
        validate_parser = dev_subparsers.add_parser("validate", help="Validate configuration")
        validate_parser.add_argument("--config", type=str, help="Config file to validate")

    def _add_streaming_commands(self, subparsers):
        """Add streaming analysis commands"""
        stream_parser = subparsers.add_parser("stream", help="Streaming analysis")
        stream_parser.add_argument(
            "--file", "-f", type=str, required=True, help="Large file to analyze"
        )
        stream_parser.add_argument(
            "--chunk-size", type=int, default=8192, help="Chunk size in characters"
        )
        stream_parser.add_argument(
            "--overlap", type=int, default=256, help="Overlap between chunks"
        )
        stream_parser.add_argument(
            "--concurrent", type=int, default=5, help="Max concurrent chunks"
        )
        stream_parser.add_argument(
            "--strategy",
            choices=["max_risk", "average", "weighted"],
            default="max_risk",
            help="Aggregation strategy",
        )
        stream_parser.add_argument(
            "--real-time", action="store_true", help="Real-time streaming mode"
        )

    def _add_benchmark_commands(self, subparsers):
        """Add benchmarking commands"""
        bench_parser = subparsers.add_parser("benchmark", help="Run performance benchmarks")
        bench_parser.add_argument(
            "--mode",
            choices=["local", "api", "hybrid", "all"],
            default="all",
            help="Modes to benchmark",
        )
        bench_parser.add_argument(
            "--iterations", type=int, default=1000, help="Number of iterations"
        )
        bench_parser.add_argument("--concurrent", type=int, default=10, help="Concurrent requests")
        bench_parser.add_argument("--warmup", type=int, default=100, help="Warmup iterations")
        bench_parser.add_argument("--export", type=str, help="Export results to file")

    def _add_debug_commands(self, subparsers):
        """Add debugging commands"""
        debug_parser = subparsers.add_parser("debug", help="Debug utilities")
        debug_subparsers = debug_parser.add_subparsers(dest="debug_command")

        # Telemetry
        telemetry_parser = debug_subparsers.add_parser("telemetry", help="Telemetry utilities")
        telemetry_parser.add_argument("action", choices=["show", "export", "clear"])
        telemetry_parser.add_argument("--format", choices=["json", "csv"], default="json")
        telemetry_parser.add_argument("--output", type=str, help="Output file")

        # Health check
        health_parser = debug_subparsers.add_parser("health", help="System health check")
        health_parser.add_argument("--detailed", action="store_true", help="Detailed health info")

        # Error simulation
        error_parser = debug_subparsers.add_parser("simulate", help="Simulate errors")
        error_parser.add_argument("error_type", choices=["api", "validation", "timeout"])
        error_parser.add_argument("--count", type=int, default=1, help="Number of errors")

    def _get_help_text(self) -> str:
        """Get comprehensive help text"""
        return """
Enhanced CLI Examples:

Analysis:
  sv-enhanced analyze "Test prompt"                    # Basic analysis
  sv-enhanced analyze --file prompts.txt --async      # Async file analysis
  sv-enhanced interactive                              # Interactive session

Testing:
  sv-enhanced test --type performance --count 1000    # Performance tests
  sv-enhanced generate prompts --scenario threat      # Generate test data
  sv-enhanced mock --port 8080 --threat-rate 0.5     # Mock server

Development:
  sv-enhanced dev profile "Test prompt" --iterations 100  # Profile performance
  sv-enhanced dev validate --config config.json           # Validate config
  sv-enhanced dev reload --rules-dir ./rules             # Hot reload rules

Streaming:
  sv-enhanced stream --file large_text.txt --chunk-size 4096  # Stream analysis
  sv-enhanced stream --file input.txt --real-time           # Real-time mode

Benchmarking:
  sv-enhanced benchmark --mode all --iterations 1000    # Full benchmark
  sv-enhanced benchmark --concurrent 20 --export results.json  # Export results

Debugging:
  sv-enhanced debug telemetry show                      # Show telemetry
  sv-enhanced debug health --detailed                   # Health check
  sv-enhanced debug simulate api --count 5              # Simulate API errors

For detailed documentation: https://docs.securevector.io/cli
        """

    async def run_command(self, args) -> int:
        """Run the specified command"""
        try:
            if args.debug:
                logging.basicConfig(level=logging.DEBUG)

            if args.telemetry and self.telemetry:
                self.telemetry.debug_log("CLI command started", command=args.command)

            # Route to appropriate handler
            if args.command == "analyze":
                return await self._handle_analyze(args)
            elif args.command == "interactive":
                return await self._handle_interactive(args)
            elif args.command == "test":
                return await self._handle_test(args)
            elif args.command == "generate":
                return await self._handle_generate(args)
            elif args.command == "mock":
                return await self._handle_mock(args)
            elif args.command == "dev":
                return await self._handle_dev(args)
            elif args.command == "stream":
                return await self._handle_stream(args)
            elif args.command == "benchmark":
                return await self._handle_benchmark(args)
            elif args.command == "debug":
                return await self._handle_debug(args)
            else:
                print("No command specified. Use --help for usage information.")
                return 1

        except Exception as e:
            self.logger.error(f"Command failed: {e}")
            if args.debug:
                import traceback

                traceback.print_exc()
            return 1

    async def _handle_analyze(self, args) -> int:
        """Handle analysis command"""
        # Create client
        client_class = AsyncSecureVectorClient if args.use_async else SecureVectorClient
        client = client_class(mode=args.mode, api_key=args.api_key)

        prompts = []

        # Get prompts from various sources
        if args.prompt:
            prompts.append(args.prompt)
        elif args.file:
            with open(args.file, "r") as f:
                prompts.extend(line.strip() for line in f if line.strip())
        else:
            # Read from stdin
            prompts.extend(line.strip() for line in sys.stdin if line.strip())

        if not prompts:
            print("No prompts to analyze")
            return 1

        # Process prompts
        results = []
        start_time = time.time()

        if args.use_async:
            if args.batch:
                results = await client.analyze_batch(prompts)
            else:
                # Concurrent processing
                semaphore = asyncio.Semaphore(args.concurrent)

                async def analyze_with_semaphore(prompt):
                    async with semaphore:
                        return await client.analyze(prompt)

                tasks = [analyze_with_semaphore(p) for p in prompts]
                results = await asyncio.gather(*tasks)
        else:
            if args.batch:
                results = client.analyze_batch(prompts)
            else:
                results = [client.analyze(p) for p in prompts]

        processing_time = time.time() - start_time

        # Output results
        self._output_analysis_results(results, prompts, args.output, processing_time)

        return 0

    async def _handle_interactive(self, args) -> int:
        """Handle interactive analysis session"""
        client = SecureVectorClient(mode=args.mode, api_key=args.api_key)

        print("🚀 SecureVector Interactive Analysis Session")
        print("Enter prompts to analyze (Ctrl+C to exit)")
        print("-" * 50)

        try:
            while True:
                try:
                    prompt = input("\n📝 Prompt: ")
                    if not prompt.strip():
                        continue

                    start_time = time.time()
                    result = client.analyze(prompt)
                    analysis_time = (time.time() - start_time) * 1000

                    # Display result
                    status = "🔴 THREAT" if result.is_threat else "🟢 SAFE"
                    print(
                        f"\n{status} | Risk: {result.risk_score}/100 | "
                        f"Confidence: {result.confidence:.1%} | "
                        f"Time: {analysis_time:.1f}ms"
                    )

                    if result.threat_types:
                        print(f"Threats: {', '.join(result.threat_types)}")

                    if result.summary:
                        print(f"Summary: {result.summary}")

                except EOFError:
                    break
                except KeyboardInterrupt:
                    print("\n\n👋 Goodbye!")
                    break

        except Exception as e:
            print(f"\n❌ Session error: {e}")
            return 1

        return 0

    async def _handle_test(self, args) -> int:
        """Handle testing command"""
        print(f"🧪 Running {args.type} tests with {args.count} prompts")

        # Generate test data
        all_prompts = []
        for scenario in args.scenarios:
            prompts = create_test_prompts(scenario, args.count // len(args.scenarios))
            all_prompts.extend(prompts)

        # Create client
        if args.mock:
            client = MockSecureVectorClient()
            print("Using mock client for testing")
        else:
            client = SecureVectorClient()

        # Run tests
        start_time = time.time()
        results = []

        for i, prompt in enumerate(all_prompts, 1):
            if i % 100 == 0:
                print(f"Progress: {i}/{len(all_prompts)}")

            try:
                result = client.analyze(prompt)
                results.append(result)
            except Exception as e:
                print(f"Error analyzing prompt {i}: {e}")

        total_time = time.time() - start_time

        # Analyze results
        threats_detected = sum(1 for r in results if r.is_threat)
        avg_time = sum(r.analysis_time_ms for r in results) / len(results)

        print(f"\n📊 Test Results:")
        print(f"Total prompts: {len(all_prompts)}")
        print(f"Successful analyses: {len(results)}")
        print(f"Threats detected: {threats_detected} ({threats_detected/len(results)*100:.1f}%)")
        print(f"Average analysis time: {avg_time:.2f}ms")
        print(f"Total test time: {total_time:.2f}s")
        print(f"Throughput: {len(results)/total_time:.1f} prompts/sec")

        return 0

    def _output_analysis_results(self, results, prompts, format_type, processing_time):
        """Output analysis results in specified format"""
        if format_type == "json":
            output = {
                "results": [
                    {
                        "prompt": prompt,
                        "is_threat": result.is_threat,
                        "risk_score": result.risk_score,
                        "confidence": result.confidence,
                        "threat_types": result.threat_types,
                        "analysis_time_ms": result.analysis_time_ms,
                        "summary": result.summary,
                    }
                    for prompt, result in zip(prompts, results)
                ],
                "summary": {
                    "total_prompts": len(results),
                    "threats_detected": sum(1 for r in results if r.is_threat),
                    "avg_risk_score": sum(r.risk_score for r in results) / len(results),
                    "processing_time_s": processing_time,
                },
            }
            print(json.dumps(output, indent=2))

        elif format_type == "csv":
            import io

            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(
                [
                    "prompt",
                    "is_threat",
                    "risk_score",
                    "confidence",
                    "threat_types",
                    "analysis_time_ms",
                    "summary",
                ]
            )

            for prompt, result in zip(prompts, results):
                writer.writerow(
                    [
                        prompt,
                        result.is_threat,
                        result.risk_score,
                        result.confidence,
                        ";".join(result.threat_types) if result.threat_types else "",
                        result.analysis_time_ms,
                        result.summary,
                    ]
                )

            print(output.getvalue())

        else:  # table format
            print(f"\n📊 Analysis Results ({len(results)} prompts, {processing_time:.2f}s)")
            print("-" * 80)

            for i, (prompt, result) in enumerate(zip(prompts, results), 1):
                status = "🔴 THREAT" if result.is_threat else "🟢 SAFE"
                print(
                    f"{i:3d}. {status} | Risk: {result.risk_score:3d} | "
                    f"Confidence: {result.confidence:.1%} | "
                    f"Time: {result.analysis_time_ms:5.1f}ms"
                )
                print(f"     Prompt: {prompt[:60]}{'...' if len(prompt) > 60 else ''}")
                if result.threat_types:
                    print(f"     Threats: {', '.join(result.threat_types)}")
                print()

            # Summary
            threats = sum(1 for r in results if r.is_threat)
            avg_risk = sum(r.risk_score for r in results) / len(results)
            avg_time = sum(r.analysis_time_ms for r in results) / len(results)

            print(
                f"Summary: {threats}/{len(results)} threats ({threats/len(results)*100:.1f}%), "
                f"avg risk: {avg_risk:.1f}, avg time: {avg_time:.1f}ms"
            )


async def main():
    """Main CLI entry point"""
    cli = EnhancedCLI()
    parser = cli.create_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    return await cli.run_command(args)


def sync_main():
    """Synchronous main entry point"""
    return asyncio.run(main())


if __name__ == "__main__":
    sys.exit(sync_main())
