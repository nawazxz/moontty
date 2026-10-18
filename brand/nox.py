# Nox, the Moontty mascot. A pixel moon working the night shift:
# block-cursor eyes (it lives in a terminal), a headset (it's on shift), stubby legs.
# Writes nox.svg (and nox-blink.svg, eyes shut) from the grid below.
import os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
# . empty  A lit moon  S night side (crescent shadow)  C crater  E eyes + mouth  H headband  K earcups  M mic  L legs  W cheeks
GRID = """
.....HHHHHHHHHH.....
....H..........H....
...H..SSSAAAAA..H...
..H.SSSSAAAAAAA..H..
..HSSSSAAAAAAAAA.H..
.KKSSSSAAAAACAAAAKK.
.KKSSSAAEAAAAEAAAKK.
.KKSSSAAEAAAAEAAAKK.
..MSSSAAEAAAAEAAAA..
..MSSSSAAAAAAAAAAA..
...MSSSAWAAAAAWAA...
...MMSSSAAAEEAAAA...
....MMSSSAAAAAAA....
......SSSAAAAAA.....
........SAAAA.......
.......L.L..L.L.....
"""
COL = {'A': '#e3a23a', 'S': '#4a3b26', 'C': '#d39433', 'E': '#1e1e1e', 'H': '#6e6e6e', 'K': '#3a3a3a', 'M': '#9a9a9a', 'L': '#e3a23a', 'W': '#d9774a'}
def svg(rows, blink=False):
    h, w = len(rows), max(len(r) for r in rows)
    out = []
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == '.': continue
            c = COL[ch]
            if blink and ch == 'E':
                c = COL['A']
                if y == 8 or y == 11: c = COL['E']  # shut eyes: bottom line only; the mouth stays
            out.append(f'<rect x="{x}" y="{y}" width="1" height="1" fill="{c}"/>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" shape-rendering="crispEdges">{"".join(out)}</svg>'
rows = [r for r in GRID.strip('\n').split('\n')]
open('nox.svg', 'w').write(svg(rows))
open('nox-blink.svg', 'w').write(svg(rows, True))
