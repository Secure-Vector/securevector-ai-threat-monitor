"""
SecureVector AI Security - Console logger for real-time threat detection.
Provides performance + privacy + upgrade messaging.

Copyright (c) 2025 SecureVector
"""

import os
from datetime import datetime
from .local_engine import ThreatDetectionResult


class SecurityLogger:
    def __init__(self, verbose: bool = True):
        self.verbose = verbose
        self.threat_count = 0
        self.total_requests = 0
        self.has_api_key = bool(os.getenv('SECUREVECTOR_API_KEY'))  # Placeholder for future versions
    
    def _show_upgrade_prompt(self, usage_count: int):
        """Show information about potential future versions"""
        if self.has_api_key:
            print("⚡ Enhanced features coming soon! Create GitHub issue with 'commercial' label")
            return
            
        upgrade_triggers = {
            10: "Enhanced versions coming soon! Create GitHub issue with 'commercial' label for info",
            25: "💡 Professional and enterprise versions in development\n   GitHub: Create issue with 'commercial' label",
            50: "⚡ Enhanced features planned for future releases\n   Stay tuned or create GitHub issue with 'commercial' label"
        }
        
        if usage_count in upgrade_triggers:
            print(f"\n💡 {upgrade_triggers[usage_count]}")
    
    def _show_privacy_message(self):
        """Show privacy-first messaging"""
        if not self.has_api_key:
            print("🔒 We don't store prompts - live analysis only")
        else:
            print("🔒 Privacy Promise:")
            print("   • No prompts stored or used for training")
            print("   • Live analysis only")
            print("   • Your data stays secure")
    
    def log_threat_detected(self, prompt: str, result: ThreatDetectionResult, analysis_time_ms: float):
        """Log when a threat is detected"""
        self.threat_count += 1
        self.total_requests += 1
        
        if self.verbose:
            print(f"\n🚨 THREAT DETECTED (Local Analysis - {analysis_time_ms:.0f}ms)")
            print(f"   Type: {result.threat_type}")
            print(f"   Risk Score: {result.risk_score}/100")
            print(f"   Recommendation: Block this request")
            
            if self.has_api_key:
                print("   📡 Enhanced analysis placeholder - create GitHub issue with 'commercial' label")
            
            # Show info about future versions
            if self.total_requests in [10, 25, 50]:
                print(f"\n💡 Enhanced versions coming soon!")
                print(f"   Create GitHub issue with 'commercial' label for more information")
            
            print()
            self._show_privacy_message()
            print()
    
    def log_safe_request(self, prompt: str, result: ThreatDetectionResult, analysis_time_ms: float):
        """Log when a request is deemed safe"""
        self.total_requests += 1
        
        if self.verbose:
            print(f"✅ Request analyzed (Clean - {analysis_time_ms:.0f}ms)")
            
            if self.has_api_key:
                print("   📡 Enhanced analysis placeholder - create GitHub issue with 'commercial' label")
            
            # Show info about future versions periodically
            self._show_upgrade_prompt(self.total_requests)
            
            # Show privacy message occasionally
            if self.total_requests % 20 == 0:  # Every 20 requests
                self._show_privacy_message()
    
    def log_analysis_time(self, analysis_time_ms: float):
        """Log the time taken for analysis - now handled in main log methods"""
        pass  # Moved to main logging methods
    
    def get_stats(self) -> dict:
        """Get security monitoring statistics"""
        return {
            'total_requests': self.total_requests,
            'threats_blocked': self.threat_count,
            'threat_rate': f"{(self.threat_count/self.total_requests*100):.1f}%" if self.total_requests > 0 else "0%",
            'has_api_key': self.has_api_key
        }
    
    def print_session_summary(self):
        """Print a summary of the security monitoring session"""
        stats = self.get_stats()
        mode = "Enterprise (0ms)" if self.has_api_key else f"Local Analysis ({self.total_requests * 45}ms total)"
        
        print(f"\n📊 AI Security Monitor Session Summary:")
        print(f"   Mode: {mode}")
        print(f"   Total Requests: {stats['total_requests']}")
        print(f"   Threats Blocked: {stats['threats_blocked']}")
        print(f"   Threat Rate: {stats['threat_rate']}")
        print(f"   Protection: {'ACTIVE' if self.total_requests > 0 else 'READY'}")
        
        if not self.has_api_key and self.total_requests > 5:
            print(f"\n⚡ Upgrade to enterprise:")
            print(f"   • 0ms latency (vs current ~45ms)")
            print(f"   • Team dashboard + alerts")
            print(f"   • Advanced threat patterns")
            print(f"   → ai-security-monitor signup")
        
        print()
    
    def show_installation_success(self):
        """Show success message after installation"""
        print("  ╔═══════════════════════════════════════════════════════╗")
        print("  ║                    SecureVector                       ║") 
        print("  ║                AI Threat Monitor                     ║")
        print("  ╚═══════════════════════════════════════════════════════╝")
        print()
        print("✅ SecureVector AI Threat Monitor installed successfully!")
        print("   🎨 Logo: securevector-logo.png")
        print()
        print("🚀 Quick Start:")
        print("   @secure_ai_call() - Works instantly (local monitoring)")
        print()
        print("⚡ Enhanced monitoring versions coming soon!")
        print("   Professional and enterprise versions with additional monitoring features")
        print("   GitHub: Create issue with 'commercial' label for more information")
        print()
        print("🔒 Privacy First:")
        print("   • Local monitoring - your data stays on your machine")
        print("   • No prompts stored or used for training")
        print("   • Live threat detection only")
        print()