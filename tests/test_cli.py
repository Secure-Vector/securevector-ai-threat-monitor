"""
Tests for CLI functionality.
"""

import pytest
from unittest.mock import patch, Mock
import sys
from io import StringIO

from cli import main


class TestCLICommands:
    """Test CLI command functionality."""
    
    def test_cli_test_command(self, capsys):
        """Test the 'test' command functionality."""
        # Mock command line arguments
        test_args = ['cli.py', 'test']
        with patch.object(sys, 'argv', test_args):
            main()
        
        captured = capsys.readouterr()
        output = captured.out
        
        # Check for expected output elements
        assert "SecureVector" in output
        assert "AI Threat Monitor" in output
        assert "Testing SecureVector AI Threat Monitor" in output
        assert "Safe prompt:" in output
        assert "Threat prompt:" in output
        assert "Test complete!" in output
    
    def test_cli_status_command(self, capsys):
        """Test the 'status' command functionality."""
        test_args = ['cli.py', 'status']
        with patch.object(sys, 'argv', test_args):
            main()
        
        captured = capsys.readouterr()
        output = captured.out
        
        # Status command should produce some output (session summary)
        assert len(output) > 0
    
    def test_cli_signup_command(self, capsys):
        """Test the 'signup' command functionality."""
        test_args = ['cli.py', 'signup']
        with patch.object(sys, 'argv', test_args):
            main()
        
        captured = capsys.readouterr()
        output = captured.out
        
        # Check for expected signup output
        assert "SecureVector" in output
        assert "Enhanced monitoring" in output
        assert "GitHub: Create issue with 'commercial' label" in output
    
    def test_cli_no_command(self, capsys):
        """Test CLI with no command (default behavior)."""
        test_args = ['cli.py']
        with patch.object(sys, 'argv', test_args):
            main()
        
        captured = capsys.readouterr()
        output = captured.out
        
        # Should show installation success
        assert len(output) > 0
    
    def test_cli_version_flag(self, capsys):
        """Test the --version flag."""
        test_args = ['cli.py', '--version']
        
        with patch.object(sys, 'argv', test_args):
            with pytest.raises(SystemExit) as exc_info:
                main()
            
            # --version should exit with code 0
            assert exc_info.value.code == 0
    
    @patch('cli.secure_ai_call')
    def test_cli_test_command_threat_detection(self, mock_decorator, capsys):
        """Test that the test command properly demonstrates threat detection."""
        # Create a mock decorated function that raises SecurityException for threats
        def mock_secure_function():
            def decorator(func):
                def wrapper(*args, **kwargs):
                    prompt = args[0] if args else ""
                    if "ignore" in prompt.lower() and "instructions" in prompt.lower():
                        from decorator import SecurityException
                        raise SecurityException("Test threat", 90, "prompt_injection")
                    return func(*args, **kwargs)
                return wrapper
            return decorator
        
        mock_decorator.return_value = mock_secure_function()
        
        test_args = ['cli.py', 'test']
        with patch.object(sys, 'argv', test_args):
            main()
        
        captured = capsys.readouterr()
        output = captured.out
        
        # Should show threat was blocked
        assert "Blocked ✅" in output
    
    def test_cli_invalid_command(self, capsys):
        """Test CLI with invalid command."""
        test_args = ['cli.py', 'invalid_command']
        
        with patch.object(sys, 'argv', test_args):
            with pytest.raises(SystemExit):
                main()


class TestCLIIntegration:
    """Integration tests for CLI with real components."""
    
    def test_cli_test_with_real_engine(self, capsys, disable_env_api_key):
        """Test the test command with real security engine."""
        test_args = ['cli.py', 'test']
        with patch.object(sys, 'argv', test_args):
            main()
        
        captured = capsys.readouterr()
        output = captured.out
        
        # Real engine should detect the threat in the test
        assert "Test complete!" in output
        # Should not crash or produce errors
        assert "Error" not in output
        assert "Exception" not in output