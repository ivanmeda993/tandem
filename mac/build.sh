#!/bin/sh
# Builds Tandem.app, the notifier the mod runs on macOS, from notifier.swift: one binary for Apple silicon and Intel,
# signed ad hoc. It needs Xcode or its command line tools; the built app is checked in, so installing Tandem needs
# neither.
set -eu
cd "$(dirname "$0")"
app=Tandem.app
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

for arch in arm64 x86_64; do
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos11" -o "$work/$arch" notifier.swift
done

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
lipo -create "$work/arm64" "$work/x86_64" -output "$app/Contents/MacOS/tandem-notify"
cp Info.plist "$app/Contents/Info.plist"

# The icon macOS shows on each notification and in System Settings > Notifications: Tandem's own.
mkdir "$work/Tandem.iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" ../assets/icon.png --out "$work/Tandem.iconset/icon_${size}x${size}.png" >/dev/null
  if [ "$size" -le 256 ]; then
    sips -z $((size * 2)) $((size * 2)) ../assets/icon.png --out "$work/Tandem.iconset/icon_${size}x${size}@2x.png" >/dev/null
  fi
done
iconutil -c icns -o "$app/Contents/Resources/Tandem.icns" "$work/Tandem.iconset"

codesign --force --sign - "$app"
