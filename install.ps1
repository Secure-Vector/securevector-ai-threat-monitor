# SecureVector AI Threat Monitor SDK - Windows PowerShell Installation Script
# Supports Windows PowerShell and PowerShell Core environments

param(
    [switch]$Force,
    [switch]$UserInstall,
    [switch]$Verbose
)

# Set error action preference
$ErrorActionPreference = "Stop"

# Function to write colored output
function Write-Status {
    param($Message)
    Write-Host "[INFO] $Message" -ForegroundColor Blue
}

function Write-Success {
    param($Message)
    Write-Host "[SUCCESS] $Message" -ForegroundColor Green
}

function Write-Warning {
    param($Message)
    Write-Host "[WARNING] $Message" -ForegroundColor Yellow
}

function Write-Error {
    param($Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

# Function to test if command exists
function Test-CommandExists {
    param($Command)
    try {
        if (Get-Command $Command -ErrorAction SilentlyContinue) {
            return $true
        }
    }
    catch {
        return $false
    }
    return $false
}

# Function to test installation
function Test-Installation {
    Write-Status "Testing installation..."

    try {
        $testScript = @"
try:
    from ai_threat_monitor import SecureVectorClient
    client = SecureVectorClient()
    print('✅ SDK imported successfully')
    print('✅ Client created successfully')

    # Test basic functionality
    result = client.analyze('Hello world')
    print('✅ Basic analysis working')
    print('🎉 Installation test PASSED')
except ImportError as e:
    print(f'❌ Import failed: {e}')
    exit(1)
except Exception as e:
    print(f'❌ Test failed: {e}')
    exit(1)
"@

        $result = python -c $testScript 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Installation test passed!"
            return $true
        }
        else {
            return $false
        }
    }
    catch {
        return $false
    }
}

# Function to install with pip
function Install-WithPip {
    param($PipCommand, $UserFlag = $false)

    $userParam = if ($UserFlag) { "--user" } else { "" }
    Write-Status "Trying installation with $PipCommand $userParam..."

    try {
        if ($UserFlag) {
            & $PipCommand install --user securevector-ai-monitor 2>$null
        }
        else {
            & $PipCommand install securevector-ai-monitor 2>$null
        }

        if ($LASTEXITCODE -eq 0) {
            Write-Success "Package installed with $PipCommand"
            if (Test-Installation) {
                return $true
            }
            else {
                Write-Warning "Package installed but verification failed"
            }
        }
    }
    catch {
        # Installation failed, continue to next method
    }
    return $false
}

# Function to install with python -m pip
function Install-WithPythonModule {
    param($UserFlag = $false)

    $userParam = if ($UserFlag) { "--user" } else { "" }
    Write-Status "Trying installation with python -m pip $userParam..."

    try {
        if ($UserFlag) {
            python -m pip install --user securevector-ai-monitor 2>$null
        }
        else {
            python -m pip install securevector-ai-monitor 2>$null
        }

        if ($LASTEXITCODE -eq 0) {
            Write-Success "Package installed with python -m pip"
            if (Test-Installation) {
                return $true
            }
        }
    }
    catch {
        # Installation failed, continue to next method
    }
    return $false
}

# Main installation logic
function Main {
    Write-Host "🛡️  SecureVector AI Threat Monitor SDK Installer" -ForegroundColor Cyan
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host ""

    Write-Status "Starting SDK installation process..."

    # Check if Python is available
    if (-not (Test-CommandExists "python")) {
        Write-Error "Python is not installed or not in PATH"
        Write-Error "Please install Python 3.8+ from https://python.org and try again"
        Write-Error ""
        Write-Error "Installation instructions:"
        Write-Error "1. Download Python from https://python.org/downloads/"
        Write-Error "2. During installation, check 'Add Python to PATH'"
        Write-Error "3. Restart PowerShell and run this script again"
        exit 1
    }

    # Check Python version
    try {
        $pythonVersion = python --version 2>&1
        Write-Status "Using Python: $pythonVersion"

        $versionCheck = python -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Python version is compatible (3.8+)"
        }
        else {
            Write-Error "Python version is not supported (requires 3.8+)"
            Write-Error "Please install Python 3.8 or higher from https://python.org"
            exit 1
        }
    }
    catch {
        Write-Error "Failed to check Python version"
        exit 1
    }

    # If user requested user installation specifically
    if ($UserInstall) {
        Write-Status "User installation requested..."

        if (Test-CommandExists "pip") {
            if (Install-WithPip "pip" -UserFlag $true) {
                Write-Success "SDK installed successfully in user mode!"
                return
            }
        }

        if (Install-WithPythonModule -UserFlag $true) {
            Write-Success "SDK installed successfully in user mode!"
            return
        }

        Write-Error "User installation failed with all methods"
        exit 1
    }

    # Try different installation methods in order of preference

    # Method 1: Standard pip
    if (Test-CommandExists "pip") {
        if (Install-WithPip "pip") {
            Write-Success "SDK installed successfully!"
            return
        }
    }

    # Method 2: Python module pip
    if (Install-WithPythonModule) {
        Write-Success "SDK installed successfully!"
        return
    }

    # Method 3: User installation with pip (fallback)
    Write-Status "Trying user installation as fallback..."
    if (Test-CommandExists "pip") {
        if (Install-WithPip "pip" -UserFlag $true) {
            Write-Success "SDK installed successfully in user mode!"
            return
        }
    }

    # Method 4: User installation with python -m pip (fallback)
    if (Install-WithPythonModule -UserFlag $true) {
        Write-Success "SDK installed successfully in user mode!"
        return
    }

    # If all methods failed
    Write-Error "All installation methods failed"
    Write-Error ""
    Write-Error "Manual installation steps:"
    Write-Error "1. Open Command Prompt or PowerShell as Administrator"
    Write-Error "2. Run: python -m pip install --upgrade pip"
    Write-Error "3. Run: python -m pip install securevector-ai-monitor"
    Write-Error ""
    Write-Error "If you continue to have issues:"
    Write-Error "• Check our documentation: https://github.com/Secure-Vector/ai-threat-monitor"
    Write-Error "• Report the issue: https://github.com/Secure-Vector/ai-threat-monitor/issues"
    Write-Error "• Include your Python version and Windows version"
    Write-Error ""
    Write-Error "Alternative: Try user installation:"
    Write-Error "PowerShell -ExecutionPolicy Bypass -File install.ps1 -UserInstall"

    exit 1
}

# Run main function
try {
    Main
}
catch {
    Write-Error "Installation script failed: $($_.Exception.Message)"
    Write-Error "Please report this issue at: https://github.com/Secure-Vector/ai-threat-monitor/issues"
    exit 1
}