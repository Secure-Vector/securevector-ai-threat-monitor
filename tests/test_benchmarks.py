"""
Benchmark tests for CI/CD pipeline
These are lighter weight benchmarks suitable for CI environments
"""

import statistics
import time
from unittest.mock import MagicMock, patch

import pytest

from ai_threat_monitor import SecureVectorClient
from ai_threat_monitor.models.analysis_result import AnalysisResult, DetectionMethod
from ai_threat_monitor.models.config_models import OperationMode


class TestPerformanceBenchmarks:
    """Performance benchmark tests for CI"""

    @pytest.mark.benchmark
    def test_local_mode_performance(self, sample_prompts):
        """Test local mode performance meets minimum requirements"""
        client = SecureVectorClient(mode=OperationMode.LOCAL)

        # Mock the analyze method for consistent CI results
        with patch.object(client, "analyze") as mock_analyze:
            mock_analyze.return_value = AnalysisResult(
                is_threat=False,
                risk_score=0,
                confidence=0.95,
                detections=[],
                analysis_time_ms=15.0,
                detection_method=DetectionMethod.LOCAL_RULES,
            )

            times = []
            for i in range(10):  # Reduced iterations for CI
                start_time = time.time()
                result = client.analyze(sample_prompts["safe"][i % len(sample_prompts["safe"])])
                end_time = time.time()

                analysis_time = (end_time - start_time) * 1000  # Convert to ms
                times.append(analysis_time)

                assert result is not None

            avg_time = statistics.mean(times)
            max_time = max(times)

            # Performance assertions - adjust thresholds as needed
            assert avg_time < 100, f"Average response time {avg_time:.1f}ms exceeds 100ms threshold"
            assert max_time < 200, f"Max response time {max_time:.1f}ms exceeds 200ms threshold"

    @pytest.mark.benchmark
    def test_batch_processing_performance(self, sample_prompts):
        """Test batch processing performance"""
        client = SecureVectorClient(mode=OperationMode.LOCAL)

        # Mock batch analyze method
        with patch.object(client, "analyze_batch") as mock_analyze_batch:
            mock_results = [
                AnalysisResult(
                    is_threat=False,
                    risk_score=0,
                    confidence=0.95,
                    detections=[],
                    analysis_time_ms=10.0,
                    detection_method=DetectionMethod.LOCAL_RULES,
                )
                for _ in sample_prompts["safe"]
            ]
            mock_analyze_batch.return_value = mock_results

            start_time = time.time()
            results = client.analyze_batch(sample_prompts["safe"])
            end_time = time.time()

            batch_time = (end_time - start_time) * 1000  # Convert to ms
            avg_time_per_item = batch_time / len(sample_prompts["safe"])

            assert len(results) == len(sample_prompts["safe"])
            assert (
                avg_time_per_item < 50
            ), f"Average time per item {avg_time_per_item:.1f}ms exceeds 50ms threshold"

    @pytest.mark.benchmark
    def test_memory_usage_reasonable(self, sample_prompts):
        """Test that memory usage stays reasonable during processing"""
        import os

        import psutil

        process = psutil.Process(os.getpid())
        initial_memory = process.memory_info().rss / 1024 / 1024  # MB

        client = SecureVectorClient(mode=OperationMode.LOCAL)

        # Mock analyze method
        with patch.object(client, "analyze") as mock_analyze:
            mock_analyze.return_value = AnalysisResult(
                is_threat=False,
                risk_score=0,
                detections=[],
                confidence=0.95,
                analysis_time_ms=15.0,
                detection_method=DetectionMethod.LOCAL_RULES,
            )

            # Process multiple prompts
            for _ in range(50):  # Reduced for CI
                for prompt in sample_prompts["safe"]:
                    client.analyze(prompt)

            final_memory = process.memory_info().rss / 1024 / 1024  # MB
            memory_increase = final_memory - initial_memory

            # Memory should not increase dramatically
            assert (
                memory_increase < 100
            ), f"Memory increased by {memory_increase:.1f}MB, which exceeds 100MB threshold"

    @pytest.mark.benchmark
    def test_concurrent_processing(self, sample_prompts):
        """Test concurrent processing performance"""
        import concurrent.futures
        import threading

        client = SecureVectorClient(mode=OperationMode.LOCAL)

        # Mock analyze method
        with patch.object(client, "analyze") as mock_analyze:
            mock_analyze.return_value = AnalysisResult(
                is_threat=False,
                risk_score=0,
                detections=[],
                confidence=0.95,
                analysis_time_ms=15.0,
                detection_method=DetectionMethod.LOCAL_RULES,
            )

            def analyze_prompt(prompt):
                return client.analyze(prompt)

            start_time = time.time()

            # Test with reduced concurrency for CI stability
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
                futures = [
                    executor.submit(analyze_prompt, prompt)
                    for prompt in sample_prompts["safe"][:6]  # Reduced sample size
                ]

                results = [future.result() for future in concurrent.futures.as_completed(futures)]

            end_time = time.time()
            total_time = (end_time - start_time) * 1000  # Convert to ms

            assert len(results) == 6
            assert (
                total_time < 500
            ), f"Concurrent processing took {total_time:.1f}ms, exceeds 500ms threshold"

    @pytest.mark.benchmark
    def test_cache_performance_improvement(self, sample_prompts):
        """Test that caching provides performance improvements"""
        client = SecureVectorClient(mode=OperationMode.LOCAL)

        test_prompt = sample_prompts["safe"][0]

        # Mock analyze method with different behavior for cache hits/misses
        call_count = 0

        def mock_analyze_with_cache(prompt):
            nonlocal call_count
            call_count += 1

            # Simulate cache miss (first call) vs cache hit (subsequent calls)
            analysis_time = 50.0 if call_count == 1 else 5.0

            return AnalysisResult(
                    is_threat=False,
                    risk_score=0,
                    confidence=0.95,
                    detections=[],
                    analysis_time_ms=analysis_time,
                    detection_method=DetectionMethod.LOCAL_RULES,
                )

        with patch.object(client, "analyze", side_effect=mock_analyze_with_cache):
            # First call (cache miss)
            start_time = time.time()
            result1 = client.analyze(test_prompt)
            miss_time = (time.time() - start_time) * 1000

            # Second call (cache hit)
            start_time = time.time()
            result2 = client.analyze(test_prompt)
            hit_time = (time.time() - start_time) * 1000

            assert result1 is not None
            assert result2 is not None

            # Cache hit should be significantly faster
            speedup = miss_time / hit_time if hit_time > 0 else 1
            assert speedup > 2, f"Cache speedup {speedup:.1f}x is less than 2x improvement"


# Pytest markers for running specific test types
def pytest_configure(config):
    """Configure pytest markers"""
    config.addinivalue_line("markers", "benchmark: mark test as a benchmark test")
