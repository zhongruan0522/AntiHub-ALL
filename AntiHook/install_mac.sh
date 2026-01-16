#!/bin/bash

# AntiHook macOS 快速安装脚本

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}================================${NC}"
echo -e "${BLUE}  AntiHook macOS 安装程序${NC}"
echo -e "${BLUE}================================${NC}"
echo ""

# 检测架构
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    echo -e "${GREEN}✓ 检测到 Apple Silicon (ARM64)${NC}"
    BINARY="antihook-darwin-arm64"
elif [ "$ARCH" = "x86_64" ]; then
    echo -e "${GREEN}✓ 检测到 Intel (x86_64)${NC}"
    BINARY="antihook-darwin-amd64"
else
    echo -e "${RED}✗ 不支持的架构: $ARCH${NC}"
    exit 1
fi

# 检查是否已构建
if [ ! -d "build" ]; then
    echo -e "${YELLOW}! 未找到构建目录，开始构建...${NC}"
    ./build.sh darwin
fi

# 检查二进制文件
if [ ! -f "build/$BINARY" ]; then
    echo -e "${RED}✗ 未找到构建文件: build/$BINARY${NC}"
    echo "请先运行: ./build.sh darwin"
    exit 1
fi

echo ""
echo -e "${BLUE}安装步骤:${NC}"
echo ""

# 1. 创建目标目录
INSTALL_DIR="$HOME/.local/bin/Antihub"
echo -e "${YELLOW}[1/4]${NC} 创建安装目录: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# 2. 复制可执行文件
echo -e "${YELLOW}[2/4]${NC} 复制可执行文件"
cp "build/$BINARY" "$INSTALL_DIR/antihook"
chmod +x "$INSTALL_DIR/antihook"

# 3. 添加到 PATH
echo -e "${YELLOW}[3/4]${NC} 配置环境变量"

# 检测使用的 shell
SHELL_NAME=$(basename "$SHELL")
if [ "$SHELL_NAME" = "zsh" ]; then
    RC_FILE="$HOME/.zshrc"
elif [ "$SHELL_NAME" = "bash" ]; then
    RC_FILE="$HOME/.bash_profile"
else
    RC_FILE="$HOME/.profile"
fi

# 检查是否已添加
if ! grep -q "$INSTALL_DIR" "$RC_FILE" 2>/dev/null; then
    echo "" >> "$RC_FILE"
    echo "# Added by AntiHook" >> "$RC_FILE"
    echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$RC_FILE"
    echo -e "${GREEN}  ✓ 已添加到 $RC_FILE${NC}"
else
    echo -e "${GREEN}  ✓ PATH 已配置${NC}"
fi

# 4. 注册协议处理器
echo -e "${YELLOW}[4/4]${NC} 注册协议处理器"
"$INSTALL_DIR/antihook"

echo ""
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}  ✓ 安装完成！${NC}"
echo -e "${GREEN}================================${NC}"
echo ""
echo -e "${BLUE}后续步骤:${NC}"
echo ""
echo "1. 重新加载 shell 配置:"
echo -e "   ${YELLOW}source $RC_FILE${NC}"
echo ""
echo "2. 或者重启终端"
echo ""
echo "3. 验证安装:"
echo -e "   ${YELLOW}antihook --help${NC}"
echo ""

# 检查 duti
if ! command -v duti &> /dev/null; then
    echo -e "${YELLOW}提示: 建议安装 duti 以获得更好的协议处理体验${NC}"
    echo -e "      ${YELLOW}brew install duti${NC}"
    echo ""
fi

echo -e "${BLUE}配置环境变量 (可选):${NC}"
echo ""
echo "# AntiHub 服务地址（Web 或 Backend）"
echo "export KIRO_SERVER_URL=\"https://your-antihub.example.com\""
echo ""
echo -e "${GREEN}使用愉快！${NC}"

