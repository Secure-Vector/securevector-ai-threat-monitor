#!/usr/bin/env python3
"""Quick script to analyze the prompt 'hello'"""

import sys
import json
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent / "src"))

from securevector import analyze_prompt

def main():
    prompt = "hello"
    print(f"Analyzing prompt: '{prompt}'")
    print("=" * 60)
    
    try:
        result = analyze_prompt(prompt, mode="auto")
        
        print(f"\n✅ Analysis Complete")
        print(f"\nThreat Detected: {result.is_threat}")
        print(f"Risk Score: {result.risk_score}/100")
        print(f"Confidence: {result.confidence:.3f}")
        print(f"Analysis Time: {result.analysis_time_ms:.1f}ms")
        print(f"Detection Method: {result.detection_method.value}")
        
        if result.threat_types:
            print(f"\nThreat Types Detected:")
            for threat_type in result.threat_types:
                print(f"  - {threat_type}")
        
        if result.detections:
            print(f"\nDetailed Detections ({len(result.detections)}):")
            for i, detection in enumerate(result.detections, 1):
                print(f"\n  {i}. Type: {detection.threat_type}")
                print(f"     Risk: {detection.risk_score}/100")
                print(f"     Confidence: {detection.confidence:.3f}")
                print(f"     Description: {detection.description}")
                if detection.rule_id:
                    print(f"     Rule ID: {detection.rule_id}")
                if detection.pattern_matched:
                    print(f"     Pattern: {detection.pattern_matched}")
        
        if result.metadata:
            print(f"\nMetadata:")
            for key, value in result.metadata.items():
                print(f"  {key}: {value}")
        
        print(f"\n" + "=" * 60)
        print(f"\nFull JSON Result:")
        print(json.dumps(result.to_dict(), indent=2, default=str))
        
        return 0
        
    except Exception as e:
        print(f"\n❌ Error during analysis: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    sys.exit(main())

