"""
Setup configuration for AI Threat Monitor
"""

from setuptools import setup, find_packages
import os

# Read the README file for long description
with open("README.md", "r", encoding="utf-8") as fh:
    long_description = fh.read()

# Read version from __init__.py
def get_version():
    version_file = os.path.join("src", "ai_threat_monitor", "__init__.py")
    with open(version_file, "r") as f:
        for line in f:
            if line.startswith("__version__"):
                return line.split("=")[1].strip().strip('"').strip("'")
    return "1.0.0"

setup(
    name="securevector-ai-monitor",
    version=get_version(),
    author="SecureVector Team",
    # author_email removed - contact via GitHub issues
    description="Real-time AI threat monitoring. Protect your apps from prompt injection, leaks, and attacks in just a few lines of code.",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/secure-vector/ai-threat-monitor",
    packages=find_packages(where="src"),
    package_dir={"": "src"},
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "Topic :: Security",
        "Topic :: Software Development :: Libraries :: Python Modules",
        "License :: OSI Approved :: Apache Software License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Operating System :: OS Independent",
    ],
    python_requires=">=3.10",
    install_requires=[
        "PyYAML>=5.1",
        "requests>=2.25.0",
        "aiohttp>=3.8.0",
        "typing-extensions>=4.0.0",
    ],
    extras_require={
        "dev": [
            "pytest>=6.0",
            "pytest-cov>=3.0",
            "pytest-xdist>=2.0",
            "pytest-asyncio>=0.21.0",
            "black>=22.0",
            "flake8>=4.0",
            "isort>=5.0",
            "mypy>=0.900",
            "safety>=2.0",
            "bandit>=1.7",
            "psutil>=5.8",  # For benchmark memory tests
        ],
        "benchmark": [
            "psutil>=5.8",
            "memory-profiler>=0.60",
        ],
    },
    include_package_data=True,
    package_data={
        "": ["rules/*.yaml", "NOTICE"],
    },
    entry_points={
        "console_scripts": [
            "sv-monitor=ai_threat_monitor.cli:main",
            "securevector-monitor=ai_threat_monitor.cli:main",
        ],
    },
    keywords="ai security llm prompt-injection threat-detection threat-monitoring openai claude securevector",
    project_urls={
        "Bug Reports": "https://github.com/secure-vector/ai-threat-monitor/issues",
        "Source": "https://github.com/secure-vector/ai-threat-monitor",
        "Documentation": "https://docs.securevector.dev/ai-threat-monitor",
        "Homepage": "https://securevector.dev",
    },
)