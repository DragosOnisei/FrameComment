#!/bin/bash

# FrameComment Quadlet Installation Script
# Installs Quadlet files to systemd and sets up services

set -e

echo "🚀 FrameComment Quadlet Installation"
echo "===================================="
echo ""

# Check if running as $USER
CURRENT_USER=$(whoami)
if [[ "$CURRENT_USER" != "$USER" ]]; then
    echo "⚠️  Warning: This should be run as $USER user"
    echo "   Current user: $CURRENT_USER"
    read -p "Continue anyway? (yes/no) [no]: " CONTINUE
    if [[ "$CONTINUE" != "yes" ]]; then
        exit 1
    fi
fi

INSTALL_DIR="$HOME/.config/containers/systemd"
SYSTEMCTL="systemctl --user"
echo "📦 Installing for $USER user (rootless Podman)"
echo "   Config dir: $INSTALL_DIR"
echo "   Data dir: /podman/framecomment"
echo ""

# Check if Podman is installed
if ! command -v podman &> /dev/null; then
    echo "❌ Error: Podman is not installed"
    echo "   Install with: sudo dnf install podman  (Fedora/RHEL)"
    echo "             or: sudo apt install podman  (Debian/Ubuntu)"
    exit 1
fi

# Check Podman version
PODMAN_VERSION=$(podman --version | grep -oP '\d+\.\d+' | head -1)
echo "✅ Found Podman version: $PODMAN_VERSION"

# Warn if version is old
if [[ $(echo "$PODMAN_VERSION < 4.4" | bc -l) -eq 1 ]]; then
    echo "⚠️  Warning: Podman 4.4+ recommended for Quadlet support"
    echo "   Your version: $PODMAN_VERSION"
    read -p "Continue anyway? (yes/no) [no]: " CONTINUE
    if [[ "$CONTINUE" != "yes" ]]; then
        exit 1
    fi
fi

echo ""

# Check if configuration was done
if grep -q "CHANGE_THIS_PASSWORD" framecomment-postgres.container 2>/dev/null; then
    echo "⚠️  Configuration not completed!"
    echo ""
    echo "Please run ./configure.sh first to set up your secrets."
    echo ""
    read -p "Run configure.sh now? (yes/no) [yes]: " RUN_CONFIGURE
    RUN_CONFIGURE=${RUN_CONFIGURE:-yes}

    if [[ "$RUN_CONFIGURE" == "yes" || "$RUN_CONFIGURE" == "y" ]]; then
        ./configure.sh
        echo ""
        echo "Configuration complete! Continuing with installation..."
        echo ""
    else
        echo "❌ Installation cancelled. Run ./configure.sh first."
        exit 1
    fi
fi

# Create install directory if it doesn't exist
mkdir -p "$INSTALL_DIR"
echo "✅ Install directory: $INSTALL_DIR"

# Check if directories exist
if [[ ! -d "/podman/framecomment" ]]; then
    echo "⚠️  Directory /podman/framecomment does not exist!"
    echo ""
    read -p "Run ./setup-directories.sh now? (yes/no) [yes]: " RUN_SETUP
    RUN_SETUP=${RUN_SETUP:-yes}

    if [[ "$RUN_SETUP" == "yes" || "$RUN_SETUP" == "y" ]]; then
        ./setup-directories.sh
        echo ""
        echo "Directories created! Continuing with installation..."
        echo ""
    else
        echo "❌ Installation cancelled. Run ./setup-directories.sh first."
        exit 1
    fi
fi

# Copy files
echo ""
echo "📁 Copying Quadlet files..."
cp -v *.container "$INSTALL_DIR/"
cp -v *.network "$INSTALL_DIR/"

echo ""
echo "🔒 Setting file permissions..."
chmod 600 "$INSTALL_DIR"/*.container
chmod 644 "$INSTALL_DIR"/*.network

echo ""
echo "🔄 Reloading systemd..."
$SYSTEMCTL daemon-reload

echo ""
echo "🐳 Pulling Docker image..."
if podman pull docker.io/dragosonisei/framecomment:latest; then
    echo "✅ Image pulled successfully"
else
    echo "⚠️  Failed to pull image. You may need to login first:"
    echo "   podman login docker.io"
    echo "   (username: dragosonisei)"
fi

echo ""
echo "✅ Installation complete!"
echo ""
echo "📋 Next steps:"
echo ""
echo "1. Enable lingering (allows rootless services to start on boot):"
echo "   sudo loginctl enable-linger $USER"
echo ""
echo "2. Start services:"
echo "   systemctl --user start framecomment-postgres.service"
echo "   systemctl --user start framecomment-redis.service"
echo "   systemctl --user start framecomment-app.service"
echo "   systemctl --user start framecomment-worker.service"
echo ""
echo "3. Enable auto-start on boot:"
echo "   systemctl --user enable framecomment-postgres.service"
echo "   systemctl --user enable framecomment-redis.service"
echo "   systemctl --user enable framecomment-app.service"
echo "   systemctl --user enable framecomment-worker.service"
echo ""
echo "4. Check status:"
echo "   systemctl --user status framecomment-*.service"
echo ""
echo "5. View logs:"
echo "   journalctl --user -u framecomment-app.service -f"
echo ""
echo "📁 Data directories:"
echo "   /podman/framecomment/postgres-data"
echo "   /podman/framecomment/redis-data"
echo "   /podman/framecomment/uploads"
echo ""
echo "🎉 Installation complete!"
