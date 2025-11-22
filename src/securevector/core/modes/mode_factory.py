"""
Factory for creating mode handlers based on configuration.

Copyright (c) 2025 SecureVector
Licensed under the Apache License, Version 2.0
"""

from typing import Union

from securevector.models.config_models import OperationMode, SDKConfig
from securevector.utils.exceptions import ConfigurationError, ModeNotAvailableError
from securevector.utils.logger import get_logger


class ModeFactory:
    """Factory for creating appropriate mode handlers"""

    @staticmethod
    def create_handler(config: SDKConfig):
        """
        Create the appropriate mode handler based on configuration.

        Args:
            config: SDK configuration

        Returns:
            Mode handler instance

        Raises:
            ModeNotAvailableError: If requested mode is not available
            ConfigurationError: If configuration is invalid
        """
        logger = get_logger(__name__, config.log_level)

        # Determine the actual mode to use
        mode = ModeFactory._determine_mode(config)
        logger.info(f"Creating handler for {mode.value} mode")

        try:
            if mode == OperationMode.LOCAL:
                from .local.local_mode import LocalMode

                return LocalMode(config.local_config)

            elif mode == OperationMode.API:
                from .api.api_mode import APIMode

                if not config.api_config.api_key:
                    raise ConfigurationError("API key required for API mode")
                return APIMode(config.api_config)

            elif mode == OperationMode.HYBRID:
                from .hybrid.hybrid_mode import HybridMode

                return HybridMode(config.local_config, config.api_config, config.hybrid_config)

            else:
                raise ModeNotAvailableError(f"Mode {mode.value} is not implemented")

        except ImportError as e:
            logger.error(f"Failed to import mode handler: {e}")
            raise ModeNotAvailableError(f"Mode {mode.value} is not available: {e}")
        except Exception as e:
            logger.error(f"Failed to create mode handler: {e}")
            raise ConfigurationError(f"Failed to initialize {mode.value} mode: {e}")

    @staticmethod
    def _determine_mode(config: SDKConfig) -> OperationMode:
        """
        Determine the actual mode to use based on configuration and availability.

        Args:
            config: SDK configuration

        Returns:
            OperationMode: The mode to use
        """
        requested_mode = config.mode

        # If specific mode requested, use it
        if requested_mode != OperationMode.AUTO:
            return requested_mode

        # Auto mode - determine best mode based on configuration
        if config.api_config.api_key:
            # API key available - prefer hybrid mode for best of both worlds
            return OperationMode.HYBRID
        else:
            # No API key - use local mode
            return OperationMode.LOCAL

    @staticmethod
    def get_available_modes() -> list:
        """Get list of available modes"""
        available = []

        try:
            from .local.local_mode import LocalMode

            available.append(OperationMode.LOCAL)
        except ImportError:
            pass

        try:
            from .api.api_mode import APIMode

            available.append(OperationMode.API)
        except ImportError:
            pass

        try:
            from .hybrid.hybrid_mode import HybridMode

            available.append(OperationMode.HYBRID)
        except ImportError:
            pass

        return available

    @staticmethod
    def is_mode_available(mode: OperationMode) -> bool:
        """Check if a specific mode is available"""
        return mode in ModeFactory.get_available_modes()
