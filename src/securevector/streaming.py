"""
Streaming analysis capabilities for the SecureVector AI Threat Monitor SDK.

This module provides streaming analysis for processing large inputs,
real-time analysis, and efficient handling of continuous data streams.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import asyncio
import logging
import threading
import time
from abc import abstractmethod
from collections import deque
from dataclasses import dataclass
from typing import (
    Any,
    AsyncGenerator,
    AsyncIterator,
    Callable,
    Dict,
    Generator,
    Iterator,
    List,
    Optional,
    Protocol,
    Union,
)

from .utils.telemetry import record_metric, trace_operation

from .models.analysis_result import AnalysisResult
from .types import AsyncBaseSecureVectorClient, BaseSecureVectorClient


@dataclass
class StreamChunk:
    """Represents a chunk of streaming data"""

    chunk_id: str
    data: str
    position: int
    total_size: Optional[int] = None
    metadata: Optional[Dict[str, Any]] = None

    @property
    def is_complete(self) -> bool:
        """Check if this is the final chunk"""
        return self.total_size is not None and self.position + len(self.data) >= self.total_size


@dataclass
class StreamAnalysisResult:
    """Result of streaming analysis"""

    chunk_id: str
    chunk_result: AnalysisResult
    position: int
    is_final_chunk: bool
    aggregated_result: Optional[AnalysisResult] = None
    processing_time_ms: float = 0.0


class StreamProcessor(Protocol):
    """Protocol for stream processing implementations"""

    @abstractmethod
    def process_chunk(self, chunk: StreamChunk) -> AnalysisResult:
        """Process a single chunk"""
        ...

    @abstractmethod
    async def process_chunk_async(self, chunk: StreamChunk) -> AnalysisResult:
        """Process a single chunk asynchronously"""
        ...


class StreamingAnalyzer:
    """Streaming analyzer for processing large inputs efficiently"""

    def __init__(
        self,
        client: BaseSecureVectorClient,
        chunk_size: int = 8192,
        overlap_size: int = 256,
        max_concurrent_chunks: int = 5,
        aggregation_strategy: str = "max_risk",
    ):
        """
        Initialize streaming analyzer.

        Args:
            client: SecureVector client for analysis
            chunk_size: Size of each chunk in characters
            overlap_size: Overlap between chunks to handle boundary cases
            max_concurrent_chunks: Maximum concurrent chunk processing
            aggregation_strategy: How to aggregate results ("max_risk", "average", "weighted")
        """
        self.client = client
        self.chunk_size = chunk_size
        self.overlap_size = overlap_size
        self.max_concurrent_chunks = max_concurrent_chunks
        self.aggregation_strategy = aggregation_strategy

        self.logger = logging.getLogger(__name__)

        # Processing state
        self._chunk_results: List[StreamAnalysisResult] = []
        self._processing_stats = {
            "total_chunks": 0,
            "processed_chunks": 0,
            "threats_detected": 0,
            "total_processing_time": 0.0,
        }

    def analyze_stream(
        self, text: str, **kwargs
    ) -> Generator[StreamAnalysisResult, None, AnalysisResult]:
        """
        Analyze a large text input as a stream of chunks.

        Args:
            text: Large text input to analyze
            **kwargs: Additional analysis options

        Yields:
            StreamAnalysisResult: Result for each processed chunk

        Returns:
            AnalysisResult: Final aggregated result
        """
        with trace_operation("stream_analysis", text_length=len(text)) as _:
            chunks = list(self._create_chunks(text))
            self._processing_stats["total_chunks"] = len(chunks)

            chunk_results = []

            for i, chunk in enumerate(chunks):
                start_time = time.time()

                try:
                    # Process individual chunk
                    chunk_result = self.client.analyze(chunk.data, **kwargs)
                    processing_time = (time.time() - start_time) * 1000

                    # Create stream result
                    stream_result = StreamAnalysisResult(
                        chunk_id=chunk.chunk_id,
                        chunk_result=chunk_result,
                        position=chunk.position,
                        is_final_chunk=(i == len(chunks) - 1),
                        processing_time_ms=processing_time,
                    )

                    chunk_results.append(stream_result)
                    self._processing_stats["processed_chunks"] += 1
                    self._processing_stats["total_processing_time"] += processing_time

                    if chunk_result.is_threat:
                        self._processing_stats["threats_detected"] += 1

                    # Record metrics
                    record_metric(f"stream.chunk.processing_time", processing_time, "ms")
                    record_metric(f"stream.chunk.risk_score", chunk_result.risk_score, "score")

                    yield stream_result

                except Exception as e:
                    self.logger.error(f"Failed to process chunk {chunk.chunk_id}: {e}")
                    # Create error result
                    error_result = AnalysisResult(
                        is_threat=True,  # Err on side of caution
                        risk_score=100,
                        confidence=0.0,
                        detections=[],
                        analysis_time_ms=(time.time() - start_time) * 1000,
                        summary=f"Processing error: {str(e)}",
                    )

                    stream_result = StreamAnalysisResult(
                        chunk_id=chunk.chunk_id,
                        chunk_result=error_result,
                        position=chunk.position,
                        is_final_chunk=(i == len(chunks) - 1),
                        processing_time_ms=(time.time() - start_time) * 1000,
                    )

                    chunk_results.append(stream_result)
                    yield stream_result

            # Aggregate final result
            aggregated_result = self._aggregate_results(chunk_results)
            record_metric(
                "stream.total_processing_time",
                self._processing_stats["total_processing_time"],
                "ms",
            )

            return aggregated_result

    async def analyze_stream_async(
        self, text: str, **kwargs
    ) -> AsyncGenerator[StreamAnalysisResult, AnalysisResult]:
        """
        Analyze a large text input as a stream asynchronously with concurrency.

        Args:
            text: Large text input to analyze
            **kwargs: Additional analysis options

        Yields:
            StreamAnalysisResult: Result for each processed chunk

        Returns:
            AnalysisResult: Final aggregated result
        """
        with trace_operation("async_stream_analysis", text_length=len(text)) as _:
            chunks = list(self._create_chunks(text))
            self._processing_stats["total_chunks"] = len(chunks)

            # Process chunks with controlled concurrency
            semaphore = asyncio.Semaphore(self.max_concurrent_chunks)
            chunk_results = []

            async def process_chunk_with_semaphore(
                chunk: StreamChunk, index: int
            ) -> StreamAnalysisResult:
                async with semaphore:
                    start_time = time.time()

                    try:
                        # Assume async client
                        if hasattr(self.client, "analyze") and asyncio.iscoroutinefunction(
                            self.client.analyze
                        ):
                            chunk_result = await self.client.analyze(chunk.data, **kwargs)
                        else:
                            # Fallback to sync in thread pool
                            chunk_result = await asyncio.get_event_loop().run_in_executor(
                                None, lambda: self.client.analyze(chunk.data, **kwargs)
                            )

                        processing_time = (time.time() - start_time) * 1000

                        stream_result = StreamAnalysisResult(
                            chunk_id=chunk.chunk_id,
                            chunk_result=chunk_result,
                            position=chunk.position,
                            is_final_chunk=(index == len(chunks) - 1),
                            processing_time_ms=processing_time,
                        )

                        self._processing_stats["processed_chunks"] += 1
                        self._processing_stats["total_processing_time"] += processing_time

                        if chunk_result.is_threat:
                            self._processing_stats["threats_detected"] += 1

                        return stream_result

                    except Exception as e:
                        self.logger.error(f"Failed to process chunk {chunk.chunk_id}: {e}")
                        processing_time = (time.time() - start_time) * 1000

                        error_result = AnalysisResult(
                            is_threat=True,
                            risk_score=100,
                            confidence=0.0,
                            detections=[],
                            analysis_time_ms=processing_time,
                            summary=f"Processing error: {str(e)}",
                        )

                        return StreamAnalysisResult(
                            chunk_id=chunk.chunk_id,
                            chunk_result=error_result,
                            position=chunk.position,
                            is_final_chunk=(index == len(chunks) - 1),
                            processing_time_ms=processing_time,
                        )

            # Create tasks for all chunks
            tasks = [process_chunk_with_semaphore(chunk, i) for i, chunk in enumerate(chunks)]

            # Process chunks and yield results as they complete
            for completed_task in asyncio.as_completed(tasks):
                result = await completed_task
                chunk_results.append(result)
                yield result

            # Sort results by position for proper aggregation
            chunk_results.sort(key=lambda x: x.position)

            # Aggregate final result
            aggregated_result = self._aggregate_results(chunk_results)
            return aggregated_result

    def _create_chunks(self, text: str) -> Generator[StreamChunk, None, None]:
        """Create overlapping chunks from input text"""
        if len(text) <= self.chunk_size:
            # Single chunk
            yield StreamChunk(chunk_id="chunk_0", data=text, position=0, total_size=len(text))
            return

        position = 0
        chunk_index = 0

        while position < len(text):
            # Calculate chunk end position
            end_position = min(position + self.chunk_size, len(text))
            chunk_data = text[position:end_position]

            yield StreamChunk(
                chunk_id=f"chunk_{chunk_index}",
                data=chunk_data,
                position=position,
                total_size=len(text),
                metadata={
                    "chunk_index": chunk_index,
                    "overlap_start": max(0, position - self.overlap_size),
                    "overlap_end": min(len(text), end_position + self.overlap_size),
                },
            )

            # Move position with overlap consideration
            if end_position == len(text):
                break

            position = end_position - self.overlap_size
            chunk_index += 1

    def _aggregate_results(self, chunk_results: List[StreamAnalysisResult]) -> AnalysisResult:
        """Aggregate chunk results into final result"""
        if not chunk_results:
            return AnalysisResult(
                is_threat=False,
                risk_score=0,
                confidence=0.0,
                detections=[],
                analysis_time_ms=0.0,
                summary="No chunks processed",
            )

        # Extract individual results
        results = [cr.chunk_result for cr in chunk_results]

        if self.aggregation_strategy == "max_risk":
            # Use result with highest risk score
            max_risk_result = max(results, key=lambda r: r.risk_score)
            aggregated = max_risk_result

        elif self.aggregation_strategy == "average":
            # Average all metrics
            avg_risk = sum(r.risk_score for r in results) / len(results)
            avg_confidence = sum(r.confidence for r in results) / len(results)
            is_threat = any(r.is_threat for r in results)

            # Combine all detections
            all_detections = []
            for result in results:
                all_detections.extend(result.detections or [])

            aggregated = AnalysisResult(
                is_threat=is_threat,
                risk_score=int(avg_risk),
                confidence=avg_confidence,
                detections=all_detections,
                analysis_time_ms=sum(cr.processing_time_ms for cr in chunk_results),
                summary=f"Aggregated analysis of {len(results)} chunks",
            )

        elif self.aggregation_strategy == "weighted":
            # Weight by chunk size and position
            total_weight = 0
            weighted_risk = 0
            weighted_confidence = 0
            is_threat = False

            for cr in chunk_results:
                weight = len(cr.chunk_result.detections or []) + 1  # Base weight of 1
                total_weight += weight
                weighted_risk += cr.chunk_result.risk_score * weight
                weighted_confidence += cr.chunk_result.confidence * weight

                if cr.chunk_result.is_threat:
                    is_threat = True

            if total_weight > 0:
                weighted_risk /= total_weight
                weighted_confidence /= total_weight

            aggregated = AnalysisResult(
                is_threat=is_threat,
                risk_score=int(weighted_risk),
                confidence=weighted_confidence,
                detections=[],  # Could aggregate detections here
                analysis_time_ms=sum(cr.processing_time_ms for cr in chunk_results),
                summary=f"Weighted aggregation of {len(results)} chunks",
            )

        else:
            # Default to max_risk
            aggregated = max(results, key=lambda r: r.risk_score)

        # Add streaming metadata
        aggregated.metadata = {
            "streaming_analysis": True,
            "total_chunks": len(chunk_results),
            "aggregation_strategy": self.aggregation_strategy,
            "processing_stats": self._processing_stats.copy(),
        }

        return aggregated

    def get_processing_stats(self) -> Dict[str, Any]:
        """Get processing statistics"""
        stats = self._processing_stats.copy()
        stats.update(
            {
                "chunk_size": self.chunk_size,
                "overlap_size": self.overlap_size,
                "max_concurrent_chunks": self.max_concurrent_chunks,
                "aggregation_strategy": self.aggregation_strategy,
                "avg_chunk_processing_time": (
                    stats["total_processing_time"] / max(stats["processed_chunks"], 1)
                ),
            }
        )
        return stats


class RealTimeStreamProcessor:
    """Real-time stream processor for continuous analysis"""

    def __init__(
        self,
        client: BaseSecureVectorClient,
        buffer_size: int = 1024,
        analysis_interval: float = 1.0,
        threat_callback: Optional[Callable[[AnalysisResult], None]] = None,
    ):
        """
        Initialize real-time stream processor.

        Args:
            client: SecureVector client for analysis
            buffer_size: Size of analysis buffer
            analysis_interval: How often to analyze buffer (seconds)
            threat_callback: Callback for when threats are detected
        """
        self.client = client
        self.buffer_size = buffer_size
        self.analysis_interval = analysis_interval
        self.threat_callback = threat_callback

        self._buffer = deque(maxlen=buffer_size)
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

        self.logger = logging.getLogger(__name__)

    def start(self) -> None:
        """Start real-time processing"""
        if self._running:
            return

        self._running = True
        self._thread = threading.Thread(target=self._processing_loop, daemon=True)
        self._thread.start()

        self.logger.info("Real-time stream processor started")

    def stop(self) -> None:
        """Stop real-time processing"""
        self._running = False
        if self._thread:
            self._thread.join(timeout=5.0)

        self.logger.info("Real-time stream processor stopped")

    def add_data(self, data: str) -> None:
        """Add data to processing buffer"""
        with self._lock:
            self._buffer.extend(data.split())  # Simple word-based buffering

    def _processing_loop(self) -> None:
        """Main processing loop"""
        while self._running:
            try:
                # Get current buffer content
                with self._lock:
                    if not self._buffer:
                        time.sleep(self.analysis_interval)
                        continue

                    # Extract buffer content
                    buffer_content = " ".join(list(self._buffer))
                    self._buffer.clear()

                # Analyze buffer content
                if buffer_content.strip():
                    result = self.client.analyze(buffer_content)

                    if result.is_threat and self.threat_callback:
                        try:
                            self.threat_callback(result)
                        except Exception as e:
                            self.logger.error(f"Threat callback failed: {e}")

                time.sleep(self.analysis_interval)

            except Exception as e:
                self.logger.error(f"Processing loop error: {e}")
                time.sleep(self.analysis_interval)

    def __enter__(self):
        """Context manager entry"""
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit"""
        self.stop()


# Convenience functions
def create_streaming_analyzer(client: BaseSecureVectorClient, **kwargs) -> StreamingAnalyzer:
    """Create a streaming analyzer with default settings"""
    return StreamingAnalyzer(client, **kwargs)


def analyze_large_text(
    client: BaseSecureVectorClient, text: str, chunk_size: int = 8192, **kwargs
) -> AnalysisResult:
    """Analyze large text using streaming approach"""
    analyzer = StreamingAnalyzer(client, chunk_size=chunk_size)

    # Process all chunks and return final result
    final_result = None
    for chunk_result in analyzer.analyze_stream(text, **kwargs):
        # Could yield intermediate results if needed
        pass

    # The generator returns the final aggregated result
    return final_result or analyzer._aggregate_results([])


async def analyze_large_text_async(
    client: AsyncBaseSecureVectorClient, text: str, chunk_size: int = 8192, **kwargs
) -> AnalysisResult:
    """Analyze large text asynchronously using streaming approach"""
    analyzer = StreamingAnalyzer(client, chunk_size=chunk_size)

    final_result = None
    async for chunk_result in analyzer.analyze_stream_async(text, **kwargs):
        # Could yield intermediate results if needed
        pass

    return final_result or analyzer._aggregate_results([])
