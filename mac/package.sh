#!/bin/zsh
# Builds a self-contained Moontty.app (server, node and dtach inside, Apple Silicon + Intel)
# and wraps it in dist/Moontty.dmg to hand to teammates. Nothing to install on their side but
# Claude Code. Unsigned (ad-hoc), so first open needs the quarantine step in the READ ME.
#   NODE_BIN=/path/to/universal/node DTACH_BIN=/path/to/universal/dtach mac/package.sh
set -e
HERE="${0:A:h}"; DECK="${HERE:h}"; DIST="$DECK/dist"; OUT="$DIST/pkg/Moontty.app"
: "${NODE_BIN:?set NODE_BIN to a universal node binary}"
: "${DTACH_BIN:?set DTACH_BIN to a universal dtach binary}"
VERSION="$(git -C "$DECK" describe --tags --always | sed 's/^v//')"

rm -rf "$DIST/pkg"; mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources/app"

# native window, both architectures
TMP="$(mktemp -d)"
for a in arm64 x86_64; do swiftc -O -target $a-apple-macos12 -o "$TMP/Moontty-$a" "$HERE/main.swift" -framework Cocoa -framework WebKit; done
lipo -create "$TMP/Moontty-arm64" "$TMP/Moontty-x86_64" -output "$OUT/Contents/MacOS/Moontty"

# icon: HTML -> 1024 PNG (headless Chrome) -> iconset -> icns
ICONSET="$TMP/AppIcon.iconset"; mkdir -p "$ICONSET"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 --window-size=1024,1024 --screenshot="$TMP/icon.png" "file://$HERE/icon.html" 2>/dev/null
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$OUT/Contents/Resources/AppIcon.icns"; rm -rf "$TMP"

# the server: tracked runtime files + node_modules (mac prebuilds only) + node + dtach
APP="$OUT/Contents/Resources/app"
git -C "$DECK" ls-files | grep -vE '^(mac|docs|brand|old-ui-v4|dist)/' | while read -r f; do mkdir -p "$APP/${f:h}"; cp "$DECK/$f" "$APP/$f"; done
cp -R "$DECK/node_modules" "$APP/"
rm -rf "$APP"/node_modules/node-pty/prebuilds/win32-*
chmod +x "$APP"/node_modules/node-pty/prebuilds/*/spawn-helper "$APP/deck" "$APP/hook.sh" "$APP"/bin/*
cp "$DTACH_BIN" "$APP/bin/dtach"
cp "$NODE_BIN" "$OUT/Contents/Resources/node"

cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Moontty</string>
  <key>CFBundleDisplayName</key><string>Moontty</string>
  <key>CFBundleIdentifier</key><string>com.nawazxz.moontty</string>
  <key>CFBundleExecutable</key><string>Moontty</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
codesign --force --deep -s - "$OUT"

# disk image: the app, an Applications shortcut and the first-open note
STAGE="$DIST/pkg/stage"; mkdir -p "$STAGE"
cp -R "$OUT" "$STAGE/"; ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/READ ME FIRST.txt" <<'TXT'
Moontty

1. Drag Moontty into Applications.
2. Open Terminal and paste this once (the app isn't signed with an Apple
   developer account, so macOS blocks it until you do):

   xattr -dr com.apple.quarantine /Applications/Moontty.app

3. Open Moontty. You land in a shell: type claude (or anything) to start.

You need Claude Code installed (https://code.claude.com). Moontty adds a
small hook to ~/.claude/settings.json on first start, so it can show each
agent's exact status; a backup is saved next to it.

Optional: brew install gh && gh auth login   (pull request status)
TXT
rm -f "$DIST/Moontty.dmg"
hdiutil create -volname Moontty -srcfolder "$STAGE" -ov -format UDZO "$DIST/Moontty.dmg" >/dev/null
rm -rf "$STAGE"
echo "app: $OUT ($(du -sh "$OUT" | cut -f1))"
echo "dmg: $DIST/Moontty.dmg ($(du -sh "$DIST/Moontty.dmg" | cut -f1))"
