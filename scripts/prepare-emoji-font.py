"""Prepare the bundled Twemoji vector font (maintenance only; needs fonttools[woff]).

Usage: python scripts/prepare-emoji-font.py /path/to/twemoji-colrv0.ttf
See assets/emoji/README.md for the pinned source and checksum.
"""
from pathlib import Path
import hashlib
import sys

from fontTools.ttLib import TTFont

source = Path(sys.argv[1])
assert hashlib.sha256(source.read_bytes()).hexdigest() == (
    '14f379d101936cb0a57c5fa5606c6ca3bd14f117dcc37d10b8a8ad58199fdefa'
), 'Unexpected upstream font; review the new release before updating the checksum'
font = TTFont(source)
assert font['COLR'].version == 0, 'Keep COLRv0 for Chromium, Firefox and Safari compatibility'
assert not any(tag in font for tag in ('sbix', 'CBDT', 'EBDT', 'SVG ')), 'Ship genuine vector outlines, not embedded bitmaps'

# Upstream retains digit keycap ligatures but omits their base cmap entries. Restore
# those existing glyphs so complete grapheme clusters shape correctly. Ordinary ASCII
# still uses the text font, which precedes the emoji font in the general font stack.
for table in font['cmap'].tables:
    if table.isUnicode() and table.format in (4, 12):
        for digit in range(10):
            table.cmap[ord('0') + digit] = f'glyph{17 + digit:05d}'

# The source build zeroes every layer's left bearing, shifting eyes/mouths/keycap
# digits to the left in Chromium. COLR layers must keep their outline origins.
for name in font.getGlyphOrder():
    outline = font['glyf'][name]
    advance, _ = font['hmtx'].metrics[name]
    font['hmtx'].metrics[name] = (advance, getattr(outline, 'xMin', 0))

# The outlines occupy -250..950 units in a 1275-unit em. Give them a real descent
# instead of upstream's zero descent, keeping the complete glyph inside a 1em cell.
font['hhea'].ascent = 1020
font['hhea'].descent = -255
font['hhea'].lineGap = 0
font['OS/2'].sTypoAscender = 1020
font['OS/2'].sTypoDescender = -255
font['OS/2'].sTypoLineGap = 0
font['OS/2'].usWinAscent = 1020
font['OS/2'].usWinDescent = 255
font['head'].created = font['head'].modified = 3877632000
font.recalcTimestamp = False
font.flavor = 'woff2'
destination = Path(__file__).resolve().parents[1] / 'webapp/src/fonts/Twemoji.woff2'
font.save(destination)
print(f'Wrote {destination} ({destination.stat().st_size:,} bytes)')
