#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release
mkdir -p dist
stage="$(mktemp -d "$PWD/dist/.build-XXXXXX")"
trap 'rm -rf "$stage"' EXIT
app="$stage/Launch Radar.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/runtime"
cp .build/release/LaunchRadar "$app/Contents/MacOS/LaunchRadar"
cp "$(command -v node)" "$app/Contents/Resources/runtime/node"
cp -R engine "$app/Contents/Resources/"
cp -R node_modules "$app/Contents/Resources/"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>LaunchRadar</string>
<key>CFBundleIdentifier</key><string>local.launchradar.app</string>
<key>CFBundleName</key><string>Launch Radar</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppleEventsUsageDescription</key><string>用于在你选择的 Safari 购买页面绑定按钮并按设定时间继续结账。</string>
</dict></plist>
PLIST
codesign --force --sign - "$app/Contents/Resources/runtime/node"
codesign --force --sign - "$app"
codesign --verify --deep --strict "$app"
rm -rf "dist/Launch Radar.app"
mv "$app" "dist/Launch Radar.app"
