#!/bin/bash
# SecureVector AI Threat Monitor SDK - Universal Installation Script
# Supports Linux, macOS, and WSL environments

set -e

echo "🛡️  SecureVector AI Threat Monitor SDK Installer"
echo "================================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to test installation
test_installation() {
    print_status "Testing installation..."

    # Try to import the module
    if python3 -c "
try:
    from securevector import SecureVectorClient
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
" 2>/dev/null; then
        return 0
    else
        return 1
    fi
}

# Function to install via pip
install_with_pip() {
    local pip_cmd="$1"
    local python_cmd="$2"

    print_status "Trying installation with $pip_cmd..."

    if $pip_cmd install securevector-ai-monitor >/dev/null 2>&1; then
        print_success "Package installed with $pip_cmd"
        if test_installation; then
            print_success "Installation verified successfully!"
            return 0
        else
            print_warning "Package installed but verification failed"
        fi
    fi
    return 1
}

# Function to install with user flag
install_user_mode() {
    local pip_cmd="$1"

    print_status "Trying user installation with $pip_cmd --user..."

    if $pip_cmd install --user securevector-ai-monitor >/dev/null 2>&1; then
        print_success "Package installed in user mode"
        if test_installation; then
            print_success "User mode installation verified!"
            return 0
        fi
    fi
    return 1
}

# Function to install with python -m pip
install_python_module() {
    local python_cmd="$1"

    print_status "Trying installation with $python_cmd -m pip..."

    if $python_cmd -m pip install securevector-ai-monitor >/dev/null 2>&1; then
        print_success "Package installed with python module"
        if test_installation; then
            print_success "Python module installation verified!"
            return 0
        fi
    fi
    return 1
}

# Main installation logic
main() {
    print_status "Starting SDK installation process..."

    # Check if Python is available
    if ! command_exists python3 && ! command_exists python; then
        print_error "Python is not installed or not in PATH"
        print_error "Please install Python 3.8+ and try again"
        exit 1
    fi

    # Determine Python command
    if command_exists python3; then
        PYTHON_CMD="python3"
    else
        PYTHON_CMD="python"
    fi

    print_status "Using Python: $($PYTHON_CMD --version 2>&1)"

    # Check Python version
    PYTHON_VERSION=$($PYTHON_CMD -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
    print_status "Python version: $PYTHON_VERSION"

    if $PYTHON_CMD -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" 2>/dev/null; then
        print_success "Python version is compatible (3.8+)"
    else
        print_error "Python version $PYTHON_VERSION is not supported"
        print_error "SecureVector SDK requires Python 3.8 or higher"
        exit 1
    fi

    # Try different installation methods in order of preference

    # Method 1: Standard pip3
    if command_exists pip3; then
        if install_with_pip "pip3" "$PYTHON_CMD"; then
            exit 0
        fi
    fi

    # Method 2: Standard pip
    if command_exists pip; then
        if install_with_pip "pip" "$PYTHON_CMD"; then
            exit 0
        fi
    fi

    # Method 3: User installation with pip3
    if command_exists pip3; then
        if install_user_mode "pip3"; then
            exit 0
        fi
    fi

    # Method 4: User installation with pip
    if command_exists pip; then
        if install_user_mode "pip"; then
            exit 0
        fi
    fi

    # Method 5: Python module pip
    if install_python_module "$PYTHON_CMD"; then
        exit 0
    fi

    # Method 6: Python module pip with user flag
    print_status "Trying python -m pip install --user..."
    if $PYTHON_CMD -m pip install --user securevector-ai-monitor >/dev/null 2>&1; then
        print_success "Package installed with python -m pip --user"
        if test_installation; then
            print_success "Python module user installation verified!"
            exit 0
        fi
    fi

    # If all methods failed
    print_error "All installation methods failed"
    print_error ""
    print_error "Manual installation steps:"
    print_error "1. Ensure you have Python 3.8+ installed"
    print_error "2. Ensure pip is installed: $PYTHON_CMD -m ensurepip --upgrade"
    print_error "3. Try manual install: $PYTHON_CMD -m pip install --user securevector-ai-monitor"
    print_error ""
    print_error "If you continue to have issues, please:"
    print_error "• Check our documentation: https://github.com/Secure-Vector/ai-threat-monitor"
    print_error "• Report the issue: https://github.com/Secure-Vector/ai-threat-monitor/issues"
    print_error "• Include your Python version and OS details"

    exit 1
}

# Run main function
main "$@"