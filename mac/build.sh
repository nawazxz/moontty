#!/bin/zsh
# Builds "Moontty.app" and installs it to /Applications.
set -e
HERE="${0:A:h}"; DECK="${HERE:h}"; OUT="$DECK/dist/Moontty.app"; NODE="$(command -v node)"
rm -rf "$OUT"; mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
swiftc -O -o "$OUT/Contents/MacOS/Moontty" "$HERE/main.swift" -framework Cocoa -framework WebKit

# icon: HTML -> 1024 PNG (headless Chrome) -> iconset -> icns
TMP="$(mktemp -d)"; ICONSET="$TMP/AppIcon.iconset"; mkdir -p "$ICONSET"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 --window-size=1024,1024 --screenshot="$TMP/icon.png" "file://$HERE/icon.html" 2>/dev/null
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$OUT/Contents/Resources/AppIcon.icns"; rm -rf "$TMP"

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
  <key>CFBundleShortVersionString</key><string>3.0</string>
  <key>CFBundleVersion</key><string>3</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>DeckDir</key><string>$DECK</string>
  <key>NodePath</key><string>$NODE</string>
</dict></plist>
PLIST
codesign --force --deep -s - "$OUT"
rm -rf "/Applications/Moontty.app"; cp -R "$OUT" /Applications/
echo "installed: /Applications/Moontty.app ($(du -sh "$OUT" | cut -f1))"
