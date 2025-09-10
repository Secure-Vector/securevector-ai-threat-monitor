"""
Setup configuration for AI Security Monitor
"""

from setuptools import setup, find_packages
import os

# Read the README file for long description
with open("README.md", "r", encoding="utf-8") as fh:
    long_description = fh.read()

# Read version from __init__.py
def get_version():
    with open("__init__.py", "r") as f:
        for line in f:
            if line.startswith("__version__"):
                return line.split("=")[1].strip().strip('"').strip("'")
    return "0.1.0"

setup(
    name="securevector-ai-monitor",
    version=get_version(),
    author="SecureVector Team",
    # author_email removed - contact via GitHub issues
    description="Real-time AI threat monitoring. Protect your apps from prompt injection, leaks, and attacks in just a few lines of code.",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/secure-vector/ai-security-monitor",
    packages=find_packages(),
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "Topic :: Security",
        "Topic :: Software Development :: Libraries :: Python Modules",
        "License :: OSI Approved :: Apache Software License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.7",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Operating System :: OS Independent",
    ],
    python_requires=">=3.7",
    install_requires=[
        "PyYAML>=5.1",
    ],
    extras_require={
        "dev": [
            "pytest>=6.0",
            "black>=22.0",
            "flake8>=4.0",
        ],
    },
    include_package_data=True,
    package_data={
        "": ["rules/*.yaml", "NOTICE"],
    },
    entry_points={
        "console_scripts": [
            "sv-monitor=cli:main",
            "securevector-monitor=cli:main",
        ],
    },
    keywords="ai security llm prompt-injection threat-detection threat-monitoring openai claude securevector",
    project_urls={
        "Bug Reports": "https://github.com/secure-vector/ai-security-monitor/issues",
        "Source": "https://github.com/secure-vector/ai-security-monitor",
        "Documentation": "https://docs.securevector.dev/ai-threat-monitor",
        "Homepage": "https://securevector.dev",
    },
)