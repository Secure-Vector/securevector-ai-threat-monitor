#!/usr/bin/env python3
"""
Local CI/CD script for development
Runs the same checks as the CI pipeline locally
"""

import subprocess
import sys
import os
from pathlib import Path

def run_command(cmd, description, continue_on_error=False):
    """Run a command and handle errors"""
    print(f"\n🔍 {description}")
    print(f"Running: {cmd}")
    
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    
    if result.returncode != 0:
        print(f"❌ {description} failed:")
        print(result.stderr)
        if not continue_on_error:
            return False
    else:
        print(f"✅ {description} passed")
        if result.stdout.strip():
            print(result.stdout)
    
    return True

def main():
    """Run local CI checks"""
    print("🚀 SecureVector AI Threat Monitor - Local CI/CD Checks")
    print("=" * 60)
    
    # Change to project root
    project_root = Path(__file__).parent.parent
    os.chdir(project_root)
    
    # Install dependencies
    if not run_command("pip install -e .[dev]", "Installing development dependencies"):
        return 1
    
    # Code formatting check
    if not run_command("black --check --diff src/ tests/ benchmarks/ scripts/", "Code formatting (black)", continue_on_error=True):
        print("💡 Run 'black src/ tests/ benchmarks/ scripts/' to fix formatting")
    
    # Import sorting check
    if not run_command("isort --check-only --diff src/ tests/ benchmarks/ scripts/", "Import sorting (isort)", continue_on_error=True):
        print("💡 Run 'isort src/ tests/ benchmarks/ scripts/' to fix imports")
    
    # Linting
    if not run_command("flake8 src/ tests/ benchmarks/ scripts/ --max-line-length=100 --extend-ignore=E203,W503", "Linting (flake8)"):
        return 1
    
    # Type checking
    run_command("mypy src/ --ignore-missing-imports", "Type checking (mypy)", continue_on_error=True)
    
    # Security checks
    run_command("safety check", "Dependency security (safety)", continue_on_error=True)
    run_command("bandit -r src/ -f json", "Code security (bandit)", continue_on_error=True)
    
    # Unit tests
    if not run_command("pytest tests/ -v --cov=src --cov-report=term-missing -m \"not benchmark\"", "Unit tests"):
        return 1
    
    # Benchmark tests
    run_command("pytest tests/test_benchmarks.py -v", "Benchmark tests", continue_on_error=True)
    
    # Package building
    if not run_command("python -m build", "Package building"):
        return 1
    
    # Package validation
    if not run_command("twine check dist/*", "Package validation"):
        return 1
    
    print("\n" + "=" * 60)
    print("🎯 Local CI checks completed!")
    print("✅ Your code is ready for CI/CD pipeline")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())

