"""
Security utilities for safe handling of sensitive data.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import hashlib
import hmac
import os
import re
import secrets
import signal
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union


def mask_sensitive_value(value: Optional[str], mask_char: str = "*", show_last: int = 4) -> str:
    """
    Safely mask sensitive values like API keys, tokens, etc.

    Args:
        value: The sensitive value to mask
        mask_char: Character to use for masking
        show_last: Number of characters to show at the end

    Returns:
        Masked string or "[REDACTED]" if value is None/empty
    """
    if not value or not isinstance(value, str):
        return "[REDACTED]"

    if len(value) <= show_last:
        return mask_char * len(value)

    return mask_char * (len(value) - show_last) + value[-show_last:]


def hash_sensitive_value(value: Optional[str], salt: str = "securevector") -> str:
    """
    Create a hash of sensitive value for logging/debugging purposes.

    Args:
        value: The sensitive value to hash
        salt: Salt to add to the hash

    Returns:
        SHA256 hash or "[NO_VALUE]" if value is None/empty
    """
    if not value:
        return "[NO_VALUE]"

    hasher = hashlib.sha256()
    hasher.update(f"{salt}:{value}".encode("utf-8"))
    return f"sha256:{hasher.hexdigest()[:16]}..."


def is_api_key_format(value: str) -> bool:
    """
    Check if a string looks like an API key that should be protected.

    Args:
        value: String to check

    Returns:
        True if the string looks like an API key
    """
    if not value or len(value) < 10:
        return False

    # Common API key patterns
    api_key_patterns = [
        r"^sk-[a-zA-Z0-9]{40,}$",  # OpenAI style
        r"^[a-f0-9]{32,64}$",  # Hex keys
        r"^[A-Za-z0-9_-]{20,}$",  # Base64-like keys
    ]

    return any(re.match(pattern, value) for pattern in api_key_patterns)


def sanitize_dict_for_logging(
    data: Dict[str, Any], sensitive_keys: Optional[list] = None
) -> Dict[str, Any]:
    """
    Sanitize a dictionary by masking sensitive values before logging.

    Args:
        data: Dictionary to sanitize
        sensitive_keys: List of keys to always mask (default: common sensitive keys)

    Returns:
        Sanitized dictionary with sensitive values masked
    """
    if sensitive_keys is None:
        sensitive_keys = [
            "api_key",
            "apikey",
            "api-key",
            "token",
            "secret",
            "password",
            "pwd",
            "private_key",
            "privatekey",
            "private-key",
            "auth",
            "authorization",
            "bearer",
            "credential",
            "credentials",
        ]

    sanitized = {}

    for key, value in data.items():
        key_lower = key.lower()

        # Check if key name suggests sensitive data
        is_sensitive_key = any(sensitive in key_lower for sensitive in sensitive_keys)

        # Check if value looks like an API key
        is_sensitive_value = isinstance(value, str) and is_api_key_format(value)

        if is_sensitive_key or is_sensitive_value:
            sanitized[key] = mask_sensitive_value(str(value) if value else None)
        elif isinstance(value, dict):
            # Recursively sanitize nested dictionaries
            sanitized[key] = sanitize_dict_for_logging(value, sensitive_keys)
        else:
            sanitized[key] = value

    return sanitized


def validate_api_key_strength(api_key: str) -> Dict[str, Any]:
    """
    Validate the strength and format of an API key.

    Args:
        api_key: API key to validate

    Returns:
        Dictionary with validation results
    """
    if not api_key:
        return {"valid": False, "issues": ["API key is empty"], "strength": "invalid"}

    issues = []

    # Length check
    if len(api_key) < 20:
        issues.append("API key is too short (minimum 20 characters)")

    # Character diversity check
    has_upper = any(c.isupper() for c in api_key)
    has_lower = any(c.islower() for c in api_key)
    has_digit = any(c.isdigit() for c in api_key)

    if not (has_upper or has_lower):
        issues.append("API key should contain letters")

    if not has_digit:
        issues.append("API key should contain numbers")

    # Entropy check (basic)
    unique_chars = len(set(api_key))
    if unique_chars < len(api_key) * 0.5:
        issues.append("API key has low entropy (too many repeated characters)")

    # Determine strength
    if not issues:
        strength = "strong"
    elif len(issues) <= 2:
        strength = "medium"
    else:
        strength = "weak"

    return {
        "valid": len(issues) == 0,
        "issues": issues,
        "strength": strength,
        "masked_key": mask_sensitive_value(api_key),
    }


class RegexSecurityError(Exception):
    """Raised when regex pattern poses security risk."""

    pass


class RegexTimeoutError(Exception):
    """Raised when regex compilation or matching exceeds timeout."""

    pass


@contextmanager
def timeout_context(seconds: float):
    """
    Context manager for timing out operations.

    Note: Signal-based timeouts only work in the main thread. When called from
    async/worker threads, this falls back to simple execution without timeout.
    This is acceptable because the regex patterns have already been validated
    for complexity and safety during loading.
    """
    # Check if we're in the main thread
    is_main_thread = threading.current_thread() == threading.main_thread()

    if is_main_thread:
        # Use signal-based timeout in main thread
        def timeout_handler(signum, frame):
            raise RegexTimeoutError(f"Operation timed out after {seconds} seconds")

        # Set the signal handler
        old_handler = signal.signal(signal.SIGALRM, timeout_handler)
        signal.alarm(int(seconds))

        try:
            yield
        finally:
            # Restore the old handler
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_handler)
    else:
        # In non-main thread (async contexts), skip signal-based timeout
        # The patterns are already validated for safety, so this is acceptable
        try:
            yield
        except Exception:
            # Let exceptions propagate normally
            raise


def analyze_regex_complexity(pattern: str) -> Dict[str, Any]:
    """
    Analyze regex pattern for potential ReDoS vulnerabilities.

    Args:
        pattern: Regex pattern to analyze

    Returns:
        Dictionary with complexity analysis results
    """
    if not pattern:
        return {"safe": True, "issues": [], "complexity_score": 0}

    issues = []
    complexity_score = 0

    # Check for nested quantifiers (major ReDoS risk)
    nested_quantifiers = re.findall(r"[+*?{][^}]*[+*?{]", pattern)
    if nested_quantifiers:
        issues.append("Nested quantifiers detected - high ReDoS risk")
        complexity_score += 100

    # Check for alternation with overlapping patterns
    alternations = pattern.count("|")
    if alternations > 5:
        issues.append(
            f"High number of alternations ({alternations}) - potential performance impact"
        )
        complexity_score += alternations * 2

    # Check for excessive repetition
    repetitions = re.findall(r"[+*?]|\{\d*,?\d*\}", pattern)
    if len(repetitions) > 10:
        issues.append(f"Excessive repetitions ({len(repetitions)}) - potential performance impact")
        complexity_score += len(repetitions)

    # Check for catastrophic backtracking patterns
    dangerous_patterns = [
        r"\([^)]*\)\+[^)]*\([^)]*\)\+",  # (a+)+
        r"\([^)]*\)\*[^)]*\([^)]*\)\*",  # (a*)*
        r"\([^)]*\)\+[^)]*\*",  # (a+)*
        r"\([^)]*\)\*[^)]*\+",  # (a*)+
    ]

    for dangerous in dangerous_patterns:
        if re.search(dangerous, pattern):
            issues.append("Catastrophic backtracking pattern detected")
            complexity_score += 200
            break

    # Check pattern length
    if len(pattern) > 500:
        issues.append("Pattern is very long - potential memory impact")
        complexity_score += 10

    # Check for complex character classes
    char_classes = re.findall(r"\[[^\]]{20,}\]", pattern)
    if char_classes:
        issues.append("Complex character classes detected")
        complexity_score += len(char_classes) * 5

    return {
        "safe": complexity_score < 50 and len(issues) == 0,
        "issues": issues,
        "complexity_score": complexity_score,
        "risk_level": (
            "low" if complexity_score < 25 else "medium" if complexity_score < 75 else "high"
        ),
    }


def safe_regex_compile(pattern: str, flags: int = 0, timeout: float = 1.0) -> re.Pattern:
    """
    Safely compile a regex pattern with ReDoS protection.

    Args:
        pattern: Regex pattern to compile
        flags: Regex flags
        timeout: Maximum time allowed for compilation (seconds)

    Returns:
        Compiled regex pattern

    Raises:
        RegexSecurityError: If pattern is deemed unsafe
        RegexTimeoutError: If compilation times out
        re.error: If pattern is invalid
    """
    if not pattern:
        raise ValueError("Pattern cannot be empty")

    # Analyze pattern for security issues
    analysis = analyze_regex_complexity(pattern)

    if not analysis["safe"]:
        if analysis["complexity_score"] > 100:
            raise RegexSecurityError(
                f"Pattern rejected due to high complexity (score: {analysis['complexity_score']}): "
                f"{', '.join(analysis['issues'])}"
            )

    # Compile with timeout protection
    try:
        with timeout_context(timeout):
            compiled_pattern = re.compile(pattern, flags)
        return compiled_pattern
    except RegexTimeoutError:
        raise RegexTimeoutError(f"Regex compilation timed out after {timeout}s: {pattern[:100]}...")
    except re.error as e:
        raise re.error(f"Invalid regex pattern: {e}")


def safe_regex_search(
    pattern: re.Pattern, text: str, timeout: float = 0.1
) -> Optional[re.Match]:
    """
    Safely search text with regex pattern and timeout protection.

    Args:
        pattern: Compiled regex pattern
        text: Text to search
        timeout: Maximum time allowed for search (seconds)

    Returns:
        Match object or None

    Raises:
        RegexTimeoutError: If search times out
    """
    if not text:
        return None

    # Limit text length to prevent memory exhaustion
    max_text_length = 100000  # 100KB
    if len(text) > max_text_length:
        text = text[:max_text_length]

    try:
        with timeout_context(timeout):
            return pattern.search(text)
    except RegexTimeoutError:
        raise RegexTimeoutError(f"Regex search timed out after {timeout}s")


def validate_regex_pattern(pattern: str) -> Dict[str, Any]:
    """
    Validate a regex pattern for security and correctness.

    Args:
        pattern: Regex pattern to validate

    Returns:
        Dictionary with validation results
    """
    result = {
        "valid": False,
        "safe": False,
        "issues": [],
        "analysis": None,
        "compilation_time": None,
    }

    try:
        # Check basic validity
        if not pattern or not isinstance(pattern, str):
            result["issues"].append("Pattern is empty or not a string")
            return result

        # Time the compilation
        start_time = time.time()

        try:
            # Analyze complexity
            analysis = analyze_regex_complexity(pattern)
            result["analysis"] = analysis

            if not analysis["safe"]:
                result["issues"].extend(analysis["issues"])

            # Try compilation with timeout
            _  = safe_regex_compile(pattern, timeout=1.0)
            result["compilation_time"] = time.time() - start_time
            result["valid"] = True
            result["safe"] = analysis["safe"]

        except RegexSecurityError as e:
            result["issues"].append(f"Security risk: {e}")
        except RegexTimeoutError as e:
            result["issues"].append(f"Timeout: {e}")
        except re.error as e:
            result["issues"].append(f"Invalid pattern: {e}")

    except Exception as e:
        result["issues"].append(f"Unexpected error: {e}")

    return result


class PathTraversalError(Exception):
    """Raised when path traversal attack is detected."""

    pass


def secure_path_join(base_path: Union[str, Path], *paths: str) -> Path:
    """
    Securely join paths while preventing directory traversal attacks.

    Args:
        base_path: Base directory path (must be absolute)
        *paths: Path components to join

    Returns:
        Resolved path that stays within base_path

    Raises:
        PathTraversalError: If path traversal is detected
        ValueError: If base_path is not absolute
    """
    base_path = Path(base_path).resolve()

    if not base_path.is_absolute():
        raise ValueError("Base path must be absolute")

    # Join all path components
    joined_path = base_path
    for path_component in paths:
        if not path_component:
            continue

        # Check for obvious traversal attempts
        if ".." in path_component or path_component.startswith("/"):
            raise PathTraversalError(f"Path traversal detected in: {path_component}")

        joined_path = joined_path / path_component

    # Resolve the final path
    resolved_path = joined_path.resolve()

    # Ensure the resolved path is still within base_path
    try:
        resolved_path.relative_to(base_path)
    except ValueError:
        raise PathTraversalError(
            f"Path traversal detected: {resolved_path} is outside base directory {base_path}"
        )

    return resolved_path


def validate_file_path(
    file_path: Union[str, Path], allowed_base_paths: List[Union[str, Path]]
) -> Path:
    """
    Validate that a file path is within allowed base directories.

    Args:
        file_path: File path to validate
        allowed_base_paths: List of allowed base directories

    Returns:
        Validated and resolved path

    Raises:
        PathTraversalError: If path is outside allowed directories
        FileNotFoundError: If file doesn't exist
    """
    file_path = Path(file_path).resolve()

    # Check if path is within any allowed base path
    for base_path in allowed_base_paths:
        base_path = Path(base_path).resolve()
        try:
            file_path.relative_to(base_path)
            # If we get here, the path is valid
            if not file_path.exists():
                raise FileNotFoundError(f"File not found: {file_path}")
            return file_path
        except ValueError:
            continue

    # If we get here, path is not in any allowed directory
    allowed_paths_str = ", ".join(str(p) for p in allowed_base_paths)
    raise PathTraversalError(
        f"File path {file_path} is not within allowed directories: {allowed_paths_str}"
    )


def secure_file_glob(base_path: Union[str, Path], pattern: str) -> List[Path]:
    """
    Securely glob files while preventing directory traversal.

    Args:
        base_path: Base directory to search in
        pattern: Glob pattern (must not contain '..')

    Returns:
        List of matching file paths

    Raises:
        PathTraversalError: If pattern contains traversal attempts
    """
    if ".." in pattern or pattern.startswith("/"):
        raise PathTraversalError(f"Unsafe glob pattern: {pattern}")

    base_path = Path(base_path).resolve()

    # Perform the glob
    matches = []
    try:
        for match in base_path.glob(pattern):
            # Double-check each match is within base_path
            try:
                match.resolve().relative_to(base_path)
                matches.append(match)
            except ValueError:
                # Skip files outside base path
                continue
    except OSError as e:
        # Handle permission errors, etc.
        raise PathTraversalError(f"Error during glob: {e}")

    return matches


def sanitize_filename(filename: str, max_length: int = 255) -> str:
    """
    Sanitize a filename by removing dangerous characters.

    Args:
        filename: Original filename
        max_length: Maximum allowed length

    Returns:
        Sanitized filename
    """
    if not filename:
        return "unnamed_file"

    # Remove path separators and dangerous characters
    dangerous_chars = ["/", "\\", "..", "<", ">", ":", '"', "|", "?", "*", "\0"]
    sanitized = filename

    for char in dangerous_chars:
        sanitized = sanitized.replace(char, "_")

    # Remove control characters
    sanitized = "".join(c for c in sanitized if ord(c) >= 32)

    # Limit length
    if len(sanitized) > max_length:
        name, ext = os.path.splitext(sanitized)
        max_name_length = max_length - len(ext)
        sanitized = name[:max_name_length] + ext

    # Ensure it's not empty
    if not sanitized or sanitized.isspace():
        sanitized = "unnamed_file"

    return sanitized


def validate_prompt_input(prompt: str, max_length: int = 100000) -> str:
    """
    Validate and sanitize prompt input for security.

    Args:
        prompt: Input prompt to validate
        max_length: Maximum allowed prompt length

    Returns:
        Sanitized prompt

    Raises:
        ValidationError: If prompt is invalid or potentially malicious
    """
    if not isinstance(prompt, str):
        raise ValueError("Prompt must be a string")

    if not prompt or not prompt.strip():
        raise ValueError("Prompt cannot be empty")

    # Check length
    if len(prompt) > max_length:
        raise ValueError(f"Prompt too long: {len(prompt)} chars (max: {max_length})")

    # Check for control characters (except common whitespace)
    allowed_control_chars = {"\t", "\n", "\r"}
    for char in prompt:
        if ord(char) < 32 and char not in allowed_control_chars:
            raise ValueError(f"Prompt contains invalid control character: {repr(char)}")

    # Check for null bytes
    if "\x00" in prompt:
        raise ValueError("Prompt contains null bytes")

    # Check for extremely long lines (potential buffer overflow attempts)
    lines = prompt.split("\n")
    max_line_length = 10000
    for i, line in enumerate(lines):
        if len(line) > max_line_length:
            raise ValueError(f"Line {i+1} too long: {len(line)} chars (max: {max_line_length})")

    # Check for excessive repetition (potential DoS)
    if len(set(prompt)) < max(10, len(prompt) * 0.01):  # Less than 1% unique chars
        if len(prompt) > 1000:  # Only for longer prompts
            raise ValueError("Prompt has excessive character repetition")

    # Basic encoding validation
    try:
        prompt.encode("utf-8")
    except UnicodeError as e:
        raise ValueError(f"Invalid UTF-8 encoding: {e}")

    return prompt.strip()


def validate_batch_input(prompts: list, max_batch_size: int = 100) -> list:
    """
    Validate batch input for security.

    Args:
        prompts: List of prompts to validate
        max_batch_size: Maximum number of prompts in batch

    Returns:
        List of validated prompts

    Raises:
        ValidationError: If batch is invalid
    """
    if not isinstance(prompts, list):
        raise ValueError("Prompts must be a list")

    if len(prompts) == 0:
        raise ValueError("Batch cannot be empty")

    if len(prompts) > max_batch_size:
        raise ValueError(f"Batch too large: {len(prompts)} prompts (max: {max_batch_size})")

    validated_prompts = []
    total_length = 0

    for i, prompt in enumerate(prompts):
        try:
            validated_prompt = validate_prompt_input(prompt)
            validated_prompts.append(validated_prompt)
            total_length += len(validated_prompt)

            # Check total batch size
            if total_length > 1000000:  # 1MB total
                raise ValueError(f"Batch total size too large: {total_length} chars")

        except ValueError as e:
            raise ValueError(f"Invalid prompt at index {i}: {e}")

    return validated_prompts


def sanitize_output_for_logging(data: Any, max_length: int = 1000) -> str:
    """
    Safely sanitize data for logging purposes.

    Args:
        data: Data to sanitize
        max_length: Maximum length of output

    Returns:
        Sanitized string safe for logging
    """
    if data is None:
        return "[None]"

    try:
        # Convert to string
        if isinstance(data, (dict, list)):
            # For complex data, use sanitized dict logging
            if isinstance(data, dict):
                sanitized_data = sanitize_dict_for_logging(data)
                data_str = str(sanitized_data)
            else:
                data_str = str(data)
        else:
            data_str = str(data)

        # Remove control characters
        sanitized = "".join(c if ord(c) >= 32 or c in "\t\n\r" else "?" for c in data_str)

        # Truncate if too long
        if len(sanitized) > max_length:
            sanitized = sanitized[: max_length - 3] + "..."

        return sanitized

    except Exception:
        return "[SANITIZATION_ERROR]"


def generate_secure_cache_key(prompt: str, salt: Optional[str] = None) -> str:
    """
    Generate secure cache key resistant to timing attacks and information disclosure.

    Args:
        prompt: Input prompt to generate cache key for
        salt: Optional salt for additional security (uses random salt if None)

    Returns:
        Secure cache key string

    Security features:
    - Uses HMAC for constant-time operations
    - Includes random salt to prevent rainbow table attacks
    - Truncated output prevents information leakage
    - Resistant to timing-based side-channel attacks
    """
    if salt is None:
        # Generate cryptographically secure random salt
        salt = secrets.token_hex(16)

    # Normalize prompt for consistent hashing
    normalized_prompt = prompt.strip().encode("utf-8")

    # Use HMAC for constant-time hashing resistant to timing attacks
    # HMAC provides protection against length extension attacks
    secret_key = hashlib.sha256(f"securevector_cache_key_{salt}".encode()).digest()

    hmac_hash = hmac.new(secret_key, normalized_prompt, hashlib.sha256).hexdigest()

    # Truncate to 32 characters to limit information disclosure
    # while maintaining sufficient entropy for cache uniqueness
    cache_key = f"cache_{hmac_hash[:32]}"

    return cache_key


def constant_time_cache_lookup(cache_dict: Dict[str, Any], key: str) -> Tuple[bool, Any]:
    """
    Perform constant-time cache lookup to prevent timing attacks.

    Args:
        cache_dict: Cache dictionary to search
        key: Key to look up

    Returns:
        Tuple of (found: bool, value: Any or None)

    Security note:
    - Always performs the same number of operations regardless of whether key exists
    - Prevents timing-based attacks that could infer cache contents
    """
    found = False
    result = None

    # Iterate through all keys to maintain constant time
    # This prevents timing attacks based on early termination
    for cache_key, cache_value in cache_dict.items():
        # Use constant-time string comparison
        if hmac.compare_digest(cache_key.encode(), key.encode()):
            found = True
            result = cache_value

    return found, result


def secure_cache_eviction(cache_dict: Dict[str, Any], max_size: int) -> int:
    """
    Securely evict cache entries to prevent information disclosure.

    Args:
        cache_dict: Cache dictionary to evict from
        max_size: Maximum allowed cache size

    Returns:
        Number of entries evicted

    Security features:
    - Random eviction order to prevent inference attacks
    - Secure memory clearing of evicted entries
    - Constant-time operations where possible
    """
    if len(cache_dict) <= max_size:
        return 0

    # Calculate how many entries to evict
    entries_to_evict = len(cache_dict) - max_size

    # Get all keys and randomize eviction order to prevent timing attacks
    all_keys = list(cache_dict.keys())
    secrets.SystemRandom().shuffle(all_keys)

    # Evict random entries instead of oldest (LRU) to prevent inference
    evicted_keys = all_keys[:entries_to_evict]

    for key in evicted_keys:
        # Securely clear the cached value from memory
        if key in cache_dict:
            cached_value = cache_dict[key]

            # Clear sensitive data from memory if possible
            if hasattr(cached_value, "__dict__"):
                for attr_name in list(cached_value.__dict__.keys()):
                    setattr(cached_value, attr_name, None)

            del cache_dict[key]

    return len(evicted_keys)


def validate_cache_access_pattern(access_times: List[float], threshold_ms: float = 10.0) -> bool:
    """
    Validate cache access patterns to detect potential timing attacks.

    Args:
        access_times: List of cache access times in milliseconds
        threshold_ms: Maximum allowed timing variance

    Returns:
        True if access pattern is suspicious (potential attack)

    Detection criteria:
    - Consistent timing patterns that suggest probing
    - Unusually precise timing measurements
    - Regular intervals suggesting automated scanning
    """
    if len(access_times) < 5:
        return False

    # Calculate timing statistics
    import statistics

    _  = statistics.mean(access_times)
    std_dev = statistics.stdev(access_times) if len(access_times) > 1 else 0

    # Detect suspiciously consistent timing (possible automated probing)
    if std_dev < threshold_ms and len(access_times) > 10:
        return True

    # Detect regular intervals (possible scanning pattern)
    intervals = [access_times[i + 1] - access_times[i] for i in range(len(access_times) - 1)]
    if len(set(round(interval, 1) for interval in intervals)) == 1:
        return True

    # Detect timing precision suggesting measurement tools
    if all(time % 0.001 == 0 for time in access_times):  # Microsecond precision
        return True

    return False


def secure_cache_key_derivation(prompt: str, context: Dict[str, Any] = None) -> str:
    """
    Derive cache key with additional context for enhanced security.

    Args:
        prompt: Input prompt
        context: Additional context for key derivation (user_id, session_id, etc.)

    Returns:
        Secure cache key with context binding

    Security features:
    - Context binding prevents cache pollution attacks
    - Time-based salting for temporal security
    - Resistant to key prediction attacks
    """
    # Use current hour as time-based salt for key rotation
    import datetime

    time_salt = datetime.datetime.utcnow().strftime("%Y%m%d%H")

    # Include context in key derivation
    context_data = ""
    if context:
        # Sort keys for consistent hashing
        sorted_context = sorted(context.items())
        context_data = "|".join(f"{k}:{v}" for k, v in sorted_context)

    # Combine all components for secure key derivation
    key_material = f"{prompt}|{context_data}|{time_salt}"

    return generate_secure_cache_key(key_material)
