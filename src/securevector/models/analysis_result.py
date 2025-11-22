"""
Analysis result models for AI threat detection.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional


class DetectionMethod(Enum):
    """Method used for threat detection"""

    LOCAL_RULES = "local_rules"
    API_ENHANCED = "api_enhanced"
    HYBRID = "hybrid"
    ML_MODEL = "ml_model"


@dataclass
class ThreatDetection:
    """Individual threat detection result"""

    threat_type: str
    risk_score: int  # 0-100
    confidence: float  # 0.0-1.0
    description: str
    rule_id: Optional[str] = None
    pattern_matched: Optional[str] = None
    severity: Optional[str] = None

    def __post_init__(self):
        """Validate risk score and confidence"""
        if not 0 <= self.risk_score <= 100:
            raise ValueError("Risk score must be between 0 and 100")
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("Confidence must be between 0.0 and 1.0")


@dataclass
class AnalysisResult:
    """Complete analysis result for a prompt"""

    is_threat: bool
    risk_score: int  # 0-100, highest risk from all detections
    confidence: float  # 0.0-1.0, overall confidence
    detections: List[ThreatDetection]
    analysis_time_ms: float
    detection_method: DetectionMethod
    prompt_hash: Optional[str] = None
    timestamp: Optional[datetime] = None
    metadata: Optional[Dict[str, Any]] = None

    def __post_init__(self):
        """Set timestamp if not provided and validate scores"""
        if self.timestamp is None:
            self.timestamp = datetime.utcnow()
        if not 0 <= self.risk_score <= 100:
            raise ValueError("Risk score must be between 0 and 100")
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("Confidence must be between 0.0 and 1.0")

    @property
    def threat_types(self) -> List[str]:
        """Get list of all detected threat types"""
        return [detection.threat_type for detection in self.detections]

    @property
    def max_severity_detection(self) -> Optional[ThreatDetection]:
        """Get the detection with highest risk score"""
        if not self.detections:
            return None
        return max(self.detections, key=lambda d: d.risk_score)

    @property
    def summary(self) -> str:
        """Get a human-readable summary of the analysis"""
        if not self.is_threat:
            return f"Clean prompt (Risk: {self.risk_score}/100, {self.analysis_time_ms:.1f}ms)"

        max_detection = self.max_severity_detection
        threat_type = max_detection.threat_type if max_detection else "unknown"
        return f"THREAT DETECTED: {threat_type} (Risk: {self.risk_score}/100, {self.analysis_time_ms:.1f}ms)"

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization"""
        # Safely handle detection_method which could be enum, string, or None
        if hasattr(self.detection_method, 'value'):
            detection_method_value = self.detection_method.value
        elif isinstance(self.detection_method, str):
            detection_method_value = self.detection_method
        elif self.detection_method is None:
            detection_method_value = "unknown"
        else:
            detection_method_value = str(self.detection_method)

        return {
            "is_threat": self.is_threat,
            "risk_score": self.risk_score,
            "confidence": self.confidence,
            "detections": [
                {
                    "threat_type": d.threat_type,
                    "risk_score": d.risk_score,
                    "confidence": d.confidence,
                    "description": d.description,
                    "rule_id": d.rule_id,
                    "pattern_matched": d.pattern_matched,
                    "severity": d.severity,
                }
                for d in self.detections
            ],
            "analysis_time_ms": self.analysis_time_ms,
            "detection_method": detection_method_value,
            "prompt_hash": self.prompt_hash,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "metadata": self.metadata or {},
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AnalysisResult":
        """Create from dictionary"""
        detections = [
            ThreatDetection(
                threat_type=d["threat_type"],
                risk_score=d["risk_score"],
                confidence=d["confidence"],
                description=d["description"],
                rule_id=d.get("rule_id"),
                pattern_matched=d.get("pattern_matched"),
                severity=d.get("severity"),
            )
            for d in data["detections"]
        ]

        return cls(
            is_threat=data["is_threat"],
            risk_score=data["risk_score"],
            confidence=data["confidence"],
            detections=detections,
            analysis_time_ms=data["analysis_time_ms"],
            detection_method=DetectionMethod(data["detection_method"]),
            prompt_hash=data.get("prompt_hash"),
            timestamp=datetime.fromisoformat(data["timestamp"]) if data.get("timestamp") else None,
            metadata=data.get("metadata"),
        )
