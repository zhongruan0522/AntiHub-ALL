#!/bin/bash

# AntiHook 构建脚本
# 支持 macOS / Windows / Linux

set -e

VERSION="1.0.0"
BUILD_DIR="build"

# 默认配置（开发环境）
DEFAULT_SERVER_URL=""

# 读取配置文件（如果存在）
CONFIG_FILE=".build.config"
if [ -f "$CONFIG_FILE" ]; then
    echo "Loading configuration from $CONFIG_FILE..."
    source "$CONFIG_FILE"
fi

# 环境变量优先级最高（兼容旧变量名 SERVER_URL）
KIRO_SERVER_URL="${KIRO_SERVER_URL:-${SERVER_URL:-$DEFAULT_SERVER_URL}}"

# 颜色输出
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}AntiHook Build Script${NC}"
echo "Version: $VERSION"
echo -e "${YELLOW}Kiro Server URL: ${KIRO_SERVER_URL:-<empty>}${NC}"
echo ""

# 创建构建目录
mkdir -p "$BUILD_DIR"

# 检测当前操作系统
OS="$(uname -s)"
case "${OS}" in
    Linux*)     MACHINE=Linux;;
    Darwin*)    MACHINE=Mac;;
    CYGWIN*)    MACHINE=Cygwin;;
    MINGW*)     MACHINE=MinGw;;
    *)          MACHINE="UNKNOWN:${OS}"
esac

echo "Detected OS: $MACHINE"
echo ""

# 获取构建时间
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# 构建 ldflags
LDFLAGS="-s -w"
LDFLAGS="$LDFLAGS -X 'main.DefaultServerURL=$KIRO_SERVER_URL'"
LDFLAGS="$LDFLAGS -X 'main.BuildVersion=$VERSION'"
LDFLAGS="$LDFLAGS -X 'main.BuildTime=$BUILD_TIME'"

# 构建 macOS 版本
build_darwin() {
    echo -e "${GREEN}Building for macOS (Intel)...${NC}"
    GOOS=darwin GOARCH=amd64 go build -ldflags="$LDFLAGS" -o "$BUILD_DIR/antihook-darwin-amd64" .
    echo "✓ Built: $BUILD_DIR/antihook-darwin-amd64"

    echo -e "${GREEN}Building for macOS (ARM64)...${NC}"
    GOOS=darwin GOARCH=arm64 go build -ldflags="$LDFLAGS" -o "$BUILD_DIR/antihook-darwin-arm64" .
    echo "✓ Built: $BUILD_DIR/antihook-darwin-arm64"
}

# 构建 Windows 版本
build_windows() {
    echo -e "${GREEN}Building for Windows (amd64)...${NC}"
    GOOS=windows GOARCH=amd64 go build -ldflags="$LDFLAGS" -o "$BUILD_DIR/antihook-windows-amd64.exe" .
    echo "✓ Built: $BUILD_DIR/antihook-windows-amd64.exe"
}

# 构建 Linux 版本
build_linux() {
    echo -e "${GREEN}Building for Linux (amd64)...${NC}"
    GOOS=linux GOARCH=amd64 go build -ldflags="$LDFLAGS" -o "$BUILD_DIR/antihook-linux-amd64" .
    echo "✓ Built: $BUILD_DIR/antihook-linux-amd64"
}

# 根据参数构建
case "$1" in
    darwin|mac|macos)
        build_darwin
        ;;
    windows|win)
        build_windows
        ;;
    linux)
        build_linux
        ;;
    all)
        build_darwin
        build_windows
        build_linux
        ;;
    *)
        echo "Usage: $0 {darwin|windows|linux|all}"
        echo ""
        echo "Building for current platform ($MACHINE)..."
        case "${MACHINE}" in
            Mac)
                build_darwin
                ;;
            Linux)
                build_linux
                ;;
            *)
                echo "Unsupported platform for auto-detection. Please specify target platform."
                exit 1
                ;;
        esac
        ;;
esac

echo ""
echo -e "${GREEN}Build completed!${NC}"
echo "Output directory: $BUILD_DIR"
ls -lh "$BUILD_DIR"

