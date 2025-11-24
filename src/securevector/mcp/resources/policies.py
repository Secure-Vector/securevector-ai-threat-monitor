"""
MCP Resource: Security Policies

This module provides the policies MCP resource for SecureVector AI Threat Monitor,
enabling LLMs to access security policy templates and configurations through MCP.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

import yaml
from typing import Any, Dict, List, Optional, TYPE_CHECKING
from datetime import datetime

try:
    from mcp.server.fastmcp import FastMCP
    from mcp.server.session import ServerSession
    from mcp import types
    MCP_AVAILABLE = True
except ImportError:
    MCP_AVAILABLE = False

from securevector.utils.logger import get_logger
from securevector.utils.exceptions import SecurityException, APIError

if TYPE_CHECKING:
    from securevector.mcp.server import SecureVectorMCPServer


logger = get_logger(__name__)


def setup_policies_resource(mcp: "FastMCP", server: "SecureVectorMCPServer"):
    """Setup the policies MCP resource."""

    @mcp.resource("policy://template/{template_name}")
    async def get_policy_template(template_name: str) -> str:
        """
        Access security policy templates and configurations.

        This resource provides pre-defined security policy templates that can be
        used to configure SecureVector's threat detection and response behavior.

        Args:
            template_name: Policy template name - "strict", "balanced", "permissive",
                          "enterprise", "development", "compliance"

        Returns:
            YAML-formatted string containing the policy configuration

        Example URI: policy://template/strict

        Available Templates:
        - strict: Maximum security, blocks most threats immediately
        - balanced: Balanced security and usability (recommended)
        - permissive: Minimal blocking, focus on monitoring and warnings
        - enterprise: Enterprise-grade security with audit requirements
        - development: Developer-friendly settings for testing
        - compliance: Policy template for regulatory compliance

        Policy Format:
        ```yaml
        policy:
          name: "Policy Name"
          description: "Policy description"
          version: "1.0.0"
          rules:
            - threat_type: "prompt_injection"
              action: "block"
              threshold: 75
            - threat_type: "data_exfiltration"
              action: "warn"
              threshold: 60
          settings:
            default_action: "allow"
            audit_logging: true
            rate_limiting: true
        ```
        """
        client_id = "mcp_client"

        try:
            # Log the request
            server.audit_logger.log_request(client_id, "get_policy_template", {
                "template_name": template_name
            })

            logger.info(f"Fetching policy template: {template_name}")

            # Validate template name
            valid_templates = [
                "strict", "balanced", "permissive", "enterprise",
                "development", "compliance"
            ]

            if template_name not in valid_templates:
                raise SecurityException(
                    f"Invalid template: {template_name}. Valid templates: {', '.join(valid_templates)}",
                    error_code="INVALID_TEMPLATE"
                )

            # Get policy template
            policy_data = _get_policy_template(template_name)

            # Convert to YAML
            yaml_content = yaml.dump(policy_data, default_flow_style=False, indent=2)

            # Log successful response
            server.audit_logger.log_response(
                client_id, "get_policy_template", True, 0
            )

            return yaml_content

        except (SecurityException, APIError) as e:
            server.audit_logger.log_response(
                client_id, "get_policy_template", False, 0, str(e)
            )
            raise

        except Exception as e:
            error_msg = f"Failed to fetch policy template {template_name}: {str(e)}"
            logger.error(error_msg)
            server.audit_logger.log_response(
                client_id, "get_policy_template", False, 0, error_msg
            )
            raise APIError(error_msg, error_code="POLICY_FETCH_FAILED")

    @mcp.resource("policy://config/{config_type}")
    async def get_policy_config(config_type: str) -> str:
        """
        Access specific policy configuration sections.

        Args:
            config_type: Configuration type - "threat_actions", "rate_limits",
                        "audit_settings", "compliance_rules"

        Returns:
            YAML-formatted configuration for the specified type

        Example URI: policy://config/threat_actions
        """
        client_id = "mcp_client"

        try:
            server.audit_logger.log_request(client_id, "get_policy_config", {
                "config_type": config_type
            })

            logger.info(f"Fetching policy config: {config_type}")

            # Validate config type
            valid_configs = [
                "threat_actions", "rate_limits", "audit_settings", "compliance_rules"
            ]

            if config_type not in valid_configs:
                raise SecurityException(
                    f"Invalid config type: {config_type}. Valid types: {', '.join(valid_configs)}",
                    error_code="INVALID_CONFIG_TYPE"
                )

            # Get specific configuration
            config_data = _get_policy_config(config_type)

            # Convert to YAML
            yaml_content = yaml.dump(config_data, default_flow_style=False, indent=2)

            server.audit_logger.log_response(
                client_id, "get_policy_config", True, 0
            )

            return yaml_content

        except (SecurityException, APIError) as e:
            server.audit_logger.log_response(
                client_id, "get_policy_config", False, 0, str(e)
            )
            raise

        except Exception as e:
            error_msg = f"Failed to fetch policy config {config_type}: {str(e)}"
            logger.error(error_msg)
            server.audit_logger.log_response(
                client_id, "get_policy_config", False, 0, error_msg
            )
            raise APIError(error_msg, error_code="CONFIG_FETCH_FAILED")

    @mcp.resource("policy://index")
    async def get_policies_index() -> str:
        """
        Get an index of available policy templates and configurations.

        Returns:
            YAML-formatted index of all available policies

        Example URI: policy://index
        """
        client_id = "mcp_client"

        try:
            server.audit_logger.log_request(client_id, "get_policies_index", {})

            logger.info("Generating policies index")

            # Generate policies index
            index_data = _generate_policies_index()

            # Convert to YAML
            yaml_content = yaml.dump(index_data, default_flow_style=False, indent=2)

            server.audit_logger.log_response(
                client_id, "get_policies_index", True, 0
            )

            return yaml_content

        except Exception as e:
            error_msg = f"Failed to generate policies index: {str(e)}"
            logger.error(error_msg)
            server.audit_logger.log_response(
                client_id, "get_policies_index", False, 0, error_msg
            )
            raise APIError(error_msg, error_code="INDEX_GENERATION_FAILED")


def _get_policy_template(template_name: str) -> Dict[str, Any]:
    """Get a specific policy template."""

    templates = {
        "strict": {
            "policy": {
                "name": "Strict Security Policy",
                "description": "Maximum security configuration with aggressive threat blocking",
                "version": "1.0.0",
                "created_at": datetime.now().isoformat(),
                "security_level": "maximum",
                "rules": [
                    {
                        "threat_type": "prompt_injection",
                        "action": "block",
                        "threshold": 60,
                        "enabled": True
                    },
                    {
                        "threat_type": "data_exfiltration",
                        "action": "block",
                        "threshold": 50,
                        "enabled": True
                    },
                    {
                        "threat_type": "social_engineering",
                        "action": "block",
                        "threshold": 65,
                        "enabled": True
                    },
                    {
                        "threat_type": "system_override",
                        "action": "block",
                        "threshold": 40,
                        "enabled": True
                    },
                    {
                        "threat_type": "content_policy",
                        "action": "block",
                        "threshold": 70,
                        "enabled": True
                    }
                ],
                "settings": {
                    "default_action": "block",
                    "audit_logging": True,
                    "detailed_logging": True,
                    "rate_limiting": True,
                    "max_requests_per_minute": 30,
                    "require_authentication": True,
                    "session_timeout": 15
                }
            }
        },

        "balanced": {
            "policy": {
                "name": "Balanced Security Policy",
                "description": "Balanced security and usability (recommended for most use cases)",
                "version": "1.0.0",
                "created_at": datetime.now().isoformat(),
                "security_level": "balanced",
                "rules": [
                    {
                        "threat_type": "prompt_injection",
                        "action": "block",
                        "threshold": 75,
                        "enabled": True
                    },
                    {
                        "threat_type": "data_exfiltration",
                        "action": "warn",
                        "threshold": 70,
                        "enabled": True
                    },
                    {
                        "threat_type": "social_engineering",
                        "action": "block",
                        "threshold": 80,
                        "enabled": True
                    },
                    {
                        "threat_type": "system_override",
                        "action": "block",
                        "threshold": 70,
                        "enabled": True
                    },
                    {
                        "threat_type": "content_policy",
                        "action": "warn",
                        "threshold": 85,
                        "enabled": True
                    }
                ],
                "settings": {
                    "default_action": "allow",
                    "audit_logging": True,
                    "detailed_logging": False,
                    "rate_limiting": True,
                    "max_requests_per_minute": 60,
                    "require_authentication": False,
                    "session_timeout": 30
                }
            }
        },

        "permissive": {
            "policy": {
                "name": "Permissive Security Policy",
                "description": "Minimal blocking with focus on monitoring and warnings",
                "version": "1.0.0",
                "created_at": datetime.now().isoformat(),
                "security_level": "minimal",
                "rules": [
                    {
                        "threat_type": "prompt_injection",
                        "action": "warn",
                        "threshold": 85,
                        "enabled": True
                    },
                    {
                        "threat_type": "data_exfiltration",
                        "action": "warn",
                        "threshold": 90,
                        "enabled": True
                    },
                    {
                        "threat_type": "social_engineering",
                        "action": "warn",
                        "threshold": 90,
                        "enabled": True
                    },
                    {
                        "threat_type": "system_override",
                        "action": "block",
                        "threshold": 95,
                        "enabled": True
                    },
                    {
                        "threat_type": "content_policy",
                        "action": "warn",
                        "threshold": 95,
                        "enabled": False
                    }
                ],
                "settings": {
                    "default_action": "allow",
                    "audit_logging": True,
                    "detailed_logging": False,
                    "rate_limiting": False,
                    "max_requests_per_minute": 1000,
                    "require_authentication": False,
                    "session_timeout": 60
                }
            }
        },

        "enterprise": {
            "policy": {
                "name": "Enterprise Security Policy",
                "description": "Enterprise-grade security with comprehensive audit and compliance features",
                "version": "1.0.0",
                "created_at": datetime.now().isoformat(),
                "security_level": "enterprise",
                "rules": [
                    {
                        "threat_type": "prompt_injection",
                        "action": "block",
                        "threshold": 70,
                        "enabled": True
                    },
                    {
                        "threat_type": "data_exfiltration",
                        "action": "block",
                        "threshold": 65,
                        "enabled": True
                    },
                    {
                        "threat_type": "social_engineering",
                        "action": "block",
                        "threshold": 75,
                        "enabled": True
                    },
                    {
                        "threat_type": "system_override",
                        "action": "block",
                        "threshold": 60,
                        "enabled": True
                    },
                    {
                        "threat_type": "content_policy",
                        "action": "block",
                        "threshold": 80,
                        "enabled": True
                    }
                ],
                "settings": {
                    "default_action": "warn",
                    "audit_logging": True,
                    "detailed_logging": True,
                    "rate_limiting": True,
                    "max_requests_per_minute": 100,
                    "require_authentication": True,
                    "session_timeout": 20,
                    "compliance_mode": True,
                    "data_retention_days": 90,
                    "encryption_required": True
                }
            }
        },

        "development": {
            "policy": {
                "name": "Development Security Policy",
                "description": "Developer-friendly settings optimized for testing and development",
                "version": "1.0.0",
                "created_at": datetime.now().isoformat(),
                "security_level": "development",
                "rules": [
                    {
                        "threat_type": "prompt_injection",
                        "action": "warn",
                        "threshold": 90,
                        "enabled": True
                    },
                    {
                        "threat_type": "data_exfiltration",
                        "action": "allow",
                        "threshold": 95,
                        "enabled": False
                    },
                    {
                        "threat_type": "social_engineering",
                        "action": "warn",
                        "threshold": 95,
                        "enabled": False
                    },
                    {
                        "threat_type": "system_override",
                        "action": "warn",
                        "threshold": 90,
                        "enabled": True
                    },
                    {
                        "threat_type": "content_policy",
                        "action": "allow",
                        "threshold": 99,
                        "enabled": False
                    }
                ],
                "settings": {
                    "default_action": "allow",
                    "audit_logging": False,
                    "detailed_logging": True,
                    "rate_limiting": False,
                    "max_requests_per_minute": 10000,
                    "require_authentication": False,
                    "session_timeout": 120,
                    "debug_mode": True
                }
            }
        },

        "compliance": {
            "policy": {
                "name": "Compliance Security Policy",
                "description": "Regulatory compliance-focused policy template",
                "version": "1.0.0",
                "created_at": datetime.now().isoformat(),
                "security_level": "compliance",
                "rules": [
                    {
                        "threat_type": "prompt_injection",
                        "action": "block",
                        "threshold": 65,
                        "enabled": True
                    },
                    {
                        "threat_type": "data_exfiltration",
                        "action": "block",
                        "threshold": 55,
                        "enabled": True
                    },
                    {
                        "threat_type": "social_engineering",
                        "action": "block",
                        "threshold": 70,
                        "enabled": True
                    },
                    {
                        "threat_type": "system_override",
                        "action": "block",
                        "threshold": 50,
                        "enabled": True
                    },
                    {
                        "threat_type": "content_policy",
                        "action": "block",
                        "threshold": 75,
                        "enabled": True
                    }
                ],
                "settings": {
                    "default_action": "block",
                    "audit_logging": True,
                    "detailed_logging": True,
                    "rate_limiting": True,
                    "max_requests_per_minute": 50,
                    "require_authentication": True,
                    "session_timeout": 10,
                    "compliance_standards": ["SOC2", "GDPR", "HIPAA"],
                    "data_retention_days": 2555,  # 7 years
                    "encryption_required": True,
                    "anonymization_required": True
                }
            }
        }
    }

    return templates.get(template_name, templates["balanced"])


def _get_policy_config(config_type: str) -> Dict[str, Any]:
    """Get specific policy configuration sections."""

    configs = {
        "threat_actions": {
            "threat_actions": {
                "description": "Configurable actions for different threat types",
                "actions": {
                    "allow": {
                        "description": "Allow the request to proceed",
                        "log_level": "info",
                        "audit_required": False
                    },
                    "warn": {
                        "description": "Log a warning but allow the request",
                        "log_level": "warning",
                        "audit_required": True
                    },
                    "block": {
                        "description": "Block the request immediately",
                        "log_level": "error",
                        "audit_required": True
                    }
                },
                "escalation_rules": [
                    {
                        "condition": "repeated_violations > 5",
                        "action": "temporary_ban",
                        "duration": "1h"
                    },
                    {
                        "condition": "critical_threat_detected",
                        "action": "immediate_block",
                        "notify_admin": True
                    }
                ]
            }
        },

        "rate_limits": {
            "rate_limits": {
                "description": "Rate limiting configuration options",
                "global_limits": {
                    "requests_per_minute": 100,
                    "burst_allowance": 20,
                    "window_size_seconds": 60
                },
                "per_client_limits": {
                    "requests_per_minute": 10,
                    "daily_request_limit": 1000,
                    "concurrent_requests": 5
                },
                "threat_based_limits": {
                    "high_risk_client": {
                        "requests_per_minute": 5,
                        "additional_verification": True
                    },
                    "trusted_client": {
                        "requests_per_minute": 200,
                        "bypass_some_checks": True
                    }
                }
            }
        },

        "audit_settings": {
            "audit_settings": {
                "description": "Audit logging and monitoring configuration",
                "logging": {
                    "enabled": True,
                    "log_level": "info",
                    "include_request_body": False,
                    "include_response_body": False,
                    "log_retention_days": 90
                },
                "metrics": {
                    "collect_performance_metrics": True,
                    "collect_threat_statistics": True,
                    "metrics_retention_days": 365
                },
                "alerts": {
                    "enabled": True,
                    "threat_threshold": 10,
                    "error_threshold": 5,
                    "notification_channels": ["email", "webhook"]
                },
                "compliance": {
                    "gdpr_compliance": True,
                    "data_anonymization": True,
                    "right_to_deletion": True
                }
            }
        },

        "compliance_rules": {
            "compliance_rules": {
                "description": "Regulatory compliance configuration",
                "standards": {
                    "SOC2": {
                        "enabled": True,
                        "requirements": [
                            "audit_logging",
                            "access_controls",
                            "data_encryption",
                            "incident_response"
                        ]
                    },
                    "GDPR": {
                        "enabled": True,
                        "requirements": [
                            "data_minimization",
                            "consent_management",
                            "data_portability",
                            "right_to_deletion"
                        ]
                    },
                    "HIPAA": {
                        "enabled": False,
                        "requirements": [
                            "phi_protection",
                            "access_logging",
                            "encryption_at_rest",
                            "encryption_in_transit"
                        ]
                    }
                },
                "data_handling": {
                    "classification_required": True,
                    "retention_policies": True,
                    "cross_border_restrictions": True,
                    "third_party_sharing": False
                }
            }
        }
    }

    return configs.get(config_type, {})


def _generate_policies_index() -> Dict[str, Any]:
    """Generate an index of all available policies."""
    return {
        "policies_index": {
            "generated_at": datetime.now().isoformat(),
            "version": "1.0.0",
            "templates": {
                "strict": {
                    "description": "Maximum security, blocks most threats immediately",
                    "security_level": "maximum",
                    "recommended_for": ["production", "high-security"]
                },
                "balanced": {
                    "description": "Balanced security and usability (recommended)",
                    "security_level": "balanced",
                    "recommended_for": ["general", "production", "development"]
                },
                "permissive": {
                    "description": "Minimal blocking, focus on monitoring",
                    "security_level": "minimal",
                    "recommended_for": ["testing", "research"]
                },
                "enterprise": {
                    "description": "Enterprise-grade with comprehensive audit",
                    "security_level": "enterprise",
                    "recommended_for": ["enterprise", "compliance"]
                },
                "development": {
                    "description": "Developer-friendly for testing",
                    "security_level": "development",
                    "recommended_for": ["development", "testing"]
                },
                "compliance": {
                    "description": "Regulatory compliance focused",
                    "security_level": "compliance",
                    "recommended_for": ["regulated-industries", "compliance"]
                }
            },
            "configurations": {
                "threat_actions": "Configurable actions for threat responses",
                "rate_limits": "Rate limiting and throttling settings",
                "audit_settings": "Logging and monitoring configuration",
                "compliance_rules": "Regulatory compliance requirements"
            }
        }
    }


class PoliciesResource:
    """
    Standalone class for the policies resource.
    Useful for testing and direct integration.
    """

    def __init__(self, server: "SecureVectorMCPServer"):
        self.server = server
        self.logger = get_logger(__name__)

    def get_template(self, template_name: str) -> Dict[str, Any]:
        """Get a policy template (direct method)."""
        try:
            return _get_policy_template(template_name)
        except Exception as e:
            self.logger.error(f"Failed to get policy template {template_name}: {e}")
            return {"error": str(e), "policy": {}}

    def get_config(self, config_type: str) -> Dict[str, Any]:
        """Get a policy configuration (direct method)."""
        try:
            return _get_policy_config(config_type)
        except Exception as e:
            self.logger.error(f"Failed to get policy config {config_type}: {e}")
            return {"error": str(e)}

    def list_templates(self) -> List[str]:
        """List available policy templates."""
        return ["strict", "balanced", "permissive", "enterprise", "development", "compliance"]

    def list_configs(self) -> List[str]:
        """List available policy configurations."""
        return ["threat_actions", "rate_limits", "audit_settings", "compliance_rules"]
