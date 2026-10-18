# Nox, the Moontty mascot. A pixel moon keeping watch:
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
COL = {'R': '#e0566a', 'G': '#9cc463', 'Z': '#9a9a9a', 'A': '#e3a23a', 'S': '#4a3b26', 'C': '#d39433', 'E': '#1e1e1e', 'H': '#6e6e6e', 'K': '#3a3a3a', 'M': '#9a9a9a', 'L': '#e3a23a', 'W': '#d9774a'}
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

# ---- moods: one per mission state in the app ----
def mood(paint, erase=()):
    g = [list(r.ljust(24, '.')) for r in rows]  # room on the right for signals
    for x, y in erase:
        g[y][x] = 'A'
    for (x, y), ch in paint.items():
        g[y][x] = ch
    return [''.join(r) for r in g]

EYES = [(8, 6), (8, 7), (8, 8), (13, 6), (13, 7), (13, 8)]
MOUTH = [(11, 11), (12, 11)]
MOODS = {
    # standby: the default face, eyes open, ready for the next prompt
    'standby': mood({}),
    # working: eyes glance down at the work, mouth set
    'working': mood({(9, 7): 'E', (9, 8): 'E', (14, 7): 'E', (14, 8): 'E', (11, 11): 'E', (19, 11): 'A', (21, 11): 'A', (23, 11): 'A'}, EYES + MOUTH),
    # needs you: wide eyes, open mouth, red light on the headset and a red signal above
    'needs-you': mood({(8, 5): 'E', (8, 6): 'E', (8, 7): 'E', (8, 8): 'E', (13, 5): 'E', (13, 6): 'E', (13, 7): 'E', (13, 8): 'E',
                       (11, 11): 'E', (12, 11): 'E', (11, 12): 'E', (12, 12): 'E',
                       (18, 6): 'R', (18, 7): 'R', (21, 0): 'R', (21, 1): 'R', (21, 2): 'R', (21, 4): 'R'}, EYES + MOUTH),
    # done: happy eyes, smile, green light on the headset
    'done': mood({(7, 7): 'E', (8, 6): 'E', (9, 7): 'E', (12, 7): 'E', (13, 6): 'E', (14, 7): 'E',
                  (10, 11): 'E', (11, 12): 'E', (12, 12): 'E', (13, 11): 'E', (18, 6): 'G', (18, 7): 'G'}, EYES + MOUTH),
    # offline: eyes shut, a little z
    'offline': mood({(7, 8): 'E', (8, 8): 'E', (9, 8): 'E', (12, 8): 'E', (13, 8): 'E', (14, 8): 'E', (11, 11): 'E',
                     (20, 0): 'Z', (21, 0): 'Z', (22, 0): 'Z', (23, 0): 'Z', (22, 1): 'Z', (21, 2): 'Z', (20, 3): 'Z', (21, 3): 'Z', (22, 3): 'Z', (23, 3): 'Z'}, EYES + MOUTH),
}
for name, g in MOODS.items():
    open(f'nox-{name}.svg', 'w').write(svg(g))
