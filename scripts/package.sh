#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift scripts/snapshot-tasks.swift
bash scripts/build.sh
stage="$(mktemp -d "$PWD/dist/.installer-XXXXXX")"
trap 'rm -rf "$stage"' EXIT
ditto "dist/Launch Radar.app" "$stage/Launch Radar.app"
ln -s /Applications "$stage/Applications"
cat > "$stage/安装说明.txt" <<'TEXT'
Launch Radar 安装说明

系统要求：Apple 芯片 Mac，macOS 14 或更新版本。

1. 将 Launch Radar 拖到 Applications（应用程序）。
2. 从「应用程序」打开 Launch Radar。
3. 本版本为本地签名，未经 Apple 公证。如果系统阻止打开，请在尝试打开后，
   前往「系统设置 → 隐私与安全性」，找到 Launch Radar 并选择「仍要打开」。

应用已包含 Node 和专用 Chromium，无需安装开发环境。
首次使用 Safari 时，请允许应用控制 Safari，并按应用提示开启网页脚本权限。
TEXT
arch="$(uname -m)"
hdiutil create -volname "Launch Radar" -srcfolder "$stage" -format UDZO -ov "dist/Launch-Radar-macOS-$arch.dmg"
hdiutil verify "dist/Launch-Radar-macOS-$arch.dmg"
