#!/usr/bin/env bash
# 目录浏览器 构建脚本 (Linux / macOS)
# 用法: ./build.sh
set -e
cd "$(dirname "$0")"

echo "[1/1] 打包 fpk ..."
python3 build_fpk.py
echo ""
echo "打包完成！在飞牛 OS 应用中心 -> 左下角"手动安装" -> 选择生成的 .fpk 文件即可安装。"
