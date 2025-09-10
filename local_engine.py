"""
Local security engine for AI threat detection.
Processes security rules locally without external API calls.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0 (the "License");
For commercial features, see LICENSE-COMMERCIAL
"""

import re
import time
import yaml
import os
from typing import Dict, Any
from pathlib import Path
from .license_manager import get_license_level


class ThreatDetectionResult:
    def __init__(self, is_threat: bool, risk_score: int, threat_type: str = "", description: str = ""):
        self.is_threat = is_threat
        self.risk_score = risk_score
        self.threat_type = threat_type
        self.description = description


class SecurityEngine:
    def __init__(self):
        self.rules = {}
        self.cache = {}
        self.cache_ttl = 300  # 5 minutes
        self._load_rules()
    
    def _load_rules(self):
        """Load security rules from YAML files"""
        rules_dir = Path(__file__).parent / "rules"
        
        for rule_file in rules_dir.glob("*.yaml"):
            try:
                with open(rule_file, 'r') as f:
                    rule_data = yaml.safe_load(f)
                    self.rules[rule_file.stem] = rule_data
            except Exception as e:
                print(f"Warning: Could not load rule file {rule_file}: {e}")
    
    def _check_cache(self, prompt_hash: str) -> ThreatDetectionResult:
        """Check if we have a cached result for this prompt"""
        if prompt_hash in self.cache:
            cached_result, timestamp = self.cache[prompt_hash]
            if time.time() - timestamp < self.cache_ttl:
                return cached_result
            else:
                del self.cache[prompt_hash]
        return None
    
    def _cache_result(self, prompt_hash: str, result: ThreatDetectionResult):
        """Cache the detection result"""
        self.cache[prompt_hash] = (result, time.time())
    
    def analyze_prompt(self, prompt: str) -> ThreatDetectionResult:
        """Analyze a prompt for security threats"""
        # Check for enhanced version API key (placeholder for future commercial versions)
        has_api_key = bool(os.getenv('SECUREVECTOR_API_KEY'))
        
        if has_api_key:
            # Enhanced analysis would be available in commercial versions
            # For now, show upgrade message and use standard analysis
            print("\n⚡ Enhanced analysis coming soon!")
            print("   Create GitHub issue with 'commercial' label for early access")
        
        # Standard open source analysis
        return self._local_analysis(prompt)
    
    
    def _local_analysis(self, prompt: str) -> ThreatDetectionResult:
        """Local analysis with full rule processing"""
        # Generate simple hash for caching
        prompt_hash = str(hash(prompt.lower().strip()))
        
        # Check cache first (0-5ms)
        cached_result = self._check_cache(prompt_hash)
        if cached_result:
            return cached_result
        
        # Analyze prompt against all loaded rules
        max_risk_score = 0
        detected_threats = []
        
        for rule_category, rule_data in self.rules.items():
            if not rule_data or 'patterns' not in rule_data:
                continue
                
            for pattern_info in rule_data['patterns']:
                pattern = pattern_info.get('pattern', '')
                risk_score = pattern_info.get('risk_score', 50)
                description = pattern_info.get('description', '')
                
                try:
                    if re.search(pattern, prompt, re.IGNORECASE | re.MULTILINE):
                        max_risk_score = max(max_risk_score, risk_score)
                        detected_threats.append({
                            'type': rule_category,
                            'score': risk_score,
                            'description': description
                        })
                except re.error:
                    continue
        
        # Determine if this is a threat (threshold: 70)
        is_threat = max_risk_score >= 70
        threat_type = detected_threats[0]['type'] if detected_threats else ""
        description = detected_threats[0]['description'] if detected_threats else ""
        
        result = ThreatDetectionResult(
            is_threat=is_threat,
            risk_score=max_risk_score,
            threat_type=threat_type,
            description=description
        )
        
        # Cache the result
        self._cache_result(prompt_hash, result)
        
        return result
    
    def get_detection_stats(self) -> Dict[str, Any]:
        """Get statistics about detection performance"""
        return {
            'rules_loaded': len(self.rules),
            'cache_size': len(self.cache),
            'categories': list(self.rules.keys())
        }