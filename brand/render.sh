#!/bin/zsh
# Renders the brand PNGs from render.html with headless Chrome. Run from anywhere.
HERE="${0:A:h}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
shot() { "$CHROME" --headless=new --hide-scrollbars --default-background-color=00000000 --allow-file-access-from-files --virtual-time-budget=4000 --window-size="$2" --screenshot="$HERE/$3" "file://$HERE/render.html?a=$1" 2>/dev/null; }
python3 "$HERE/nox.py"
shot logo 760,190 logo.png
shot logo-light 760,190 logo-light.png
shot social 1280,640 social-preview.png
shot mascot 720,720 nox.png
ls -1 "$HERE"/*.png
