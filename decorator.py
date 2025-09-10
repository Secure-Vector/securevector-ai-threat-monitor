"""
Decorator for easy AI security integration.
Provides the @secure_ai_call() decorator for protecting AI API calls.
"""

import functools
import time
from typing import Callable, Any
from .local_engine import SecurityEngine, ThreatDetectionResult
from .console_logger import SecurityLogger


class SecurityException(Exception):
    """Exception raised when a security threat is detected"""
    def __init__(self, message: str, risk_score: int, threat_type: str):
        super().__init__(message)
        self.risk_score = risk_score
        self.threat_type = threat_type


# Global instances for the decorator
_security_engine = None
_security_logger = None


def get_security_engine():
    """Get or create the global security engine"""
    global _security_engine
    if _security_engine is None:
        _security_engine = SecurityEngine()
    return _security_engine


def get_security_logger():
    """Get or create the global security logger"""
    global _security_logger
    if _security_logger is None:
        _security_logger = SecurityLogger()
    return _security_logger


def secure_ai_call(block_threshold: int = 70, log_all: bool = True, raise_on_threat: bool = True):
    """
    Decorator to secure AI API calls with real-time threat detection.
    
    Args:
        block_threshold: Risk score threshold for blocking (default: 70)
        log_all: Whether to log all requests or only threats (default: True)
        raise_on_threat: Whether to raise exception on threat detection (default: True)
    
    Usage:
        @secure_ai_call()
        def call_openai(prompt):
            return openai.chat.completions.create(
                model="gpt-4",
                messages=[{"role": "user", "content": prompt}]
            )
    """
    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def wrapper(*args, **kwargs) -> Any:
            # Extract prompt from arguments (assume first string arg or 'prompt' kwarg)
            prompt = None
            
            # Try to find prompt in args
            for arg in args:
                if isinstance(arg, str) and len(arg) > 10:  # Likely a prompt
                    prompt = arg
                    break
            
            # Try to find prompt in kwargs
            if prompt is None:
                for key in ['prompt', 'message', 'text', 'content']:
                    if key in kwargs and isinstance(kwargs[key], str):
                        prompt = kwargs[key]
                        break
            
            # If we found a prompt, analyze it
            if prompt:
                engine = get_security_engine()
                logger = get_security_logger()
                
                start_time = time.time()
                result = engine.analyze_prompt(prompt)
                analysis_time_ms = (time.time() - start_time) * 1000
                
                # Check if this is a threat
                if result.is_threat and result.risk_score >= block_threshold:
                    logger.log_threat_detected(prompt, result, analysis_time_ms)
                    
                    if raise_on_threat:
                        raise SecurityException(
                            f"Security threat detected: {result.description} (Risk: {result.risk_score}/100)",
                            result.risk_score,
                            result.threat_type
                        )
                    else:
                        return None  # Block the call but don't raise
                
                elif log_all:
                    logger.log_safe_request(prompt, result, analysis_time_ms)
            
            # Call the original function if no threat detected
            return func(*args, **kwargs)
        
        return wrapper
    return decorator


def get_session_stats() -> dict:
    """Get current session statistics"""
    logger = get_security_logger()
    engine = get_security_engine()
    
    return {
        **logger.get_stats(),
        **engine.get_detection_stats()
    }


def print_session_summary():
    """Print a summary of the current security session"""
    logger = get_security_logger()
    logger.print_session_summary()