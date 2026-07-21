#!/bin/bash
# Marginalia 一键启动脚本

set -e

echo ""
echo "================================"
echo "  Marginalia - EPUB 电子书阅读器"
echo "================================"
echo ""

# Check Python
if ! command -v python3 &>/dev/null && ! command -v python &>/dev/null; then
    echo "[ERROR] 未检测到 Python，请先安装 Python 3.12+"
    echo "        下载地址：https://www.python.org/downloads/"
    exit 1
fi

PYTHON=$(command -v python3 || command -v python)

# Switch to script directory
cd "$(dirname "$0")/backend"

# Copy .env if not exists
if [ ! -f ".env" ]; then
    echo "[INFO] 创建 .env 配置文件..."
    cp "../.env.example" ".env"
fi

# Check and install dependencies
echo "[INFO] 检查依赖..."
if ! $PYTHON -c "import fastapi" 2>/dev/null; then
    echo "[INFO] 安装依赖中，请稍候..."
    $PYTHON -m pip install -r requirements.txt -q
    echo "[INFO] 依赖安装完成"
fi

# Open browser
echo "[INFO] 启动浏览器..."
if command -v open &>/dev/null; then
    open "http://localhost:8720"
elif command -v start &>/dev/null; then
    start "http://localhost:8720"
elif command -v xdg-open &>/dev/null; then
    xdg-open "http://localhost:8720"
fi

# Start server
echo ""
echo "[INFO] 服务启动中 → http://localhost:8720"
echo "[INFO] 按 Ctrl+C 停止服务"
echo ""

$PYTHON -m uvicorn main:app --host 0.0.0.0 --port 8720 --reload
