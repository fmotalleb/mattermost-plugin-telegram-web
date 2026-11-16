"""Bundle Telegram Web's default PNG emoji into a cross-platform sbix webfont.

Maintenance only: install fonttools[woff] and Pillow, then run with the pinned
Telegram Web checkout's dist/img-apple-64 directory. See assets/emoji/README.md.
"""
from pathlib import Path
import hashlib
from io import BytesIO
import sys

from fontTools.fontBuilder import FontBuilder
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables.sbixGlyph import Glyph
from fontTools.ttLib.tables.sbixStrike import Strike
from PIL import Image

source = Path(sys.argv[1])
files = sorted(source.glob('*.png'))
assert len(files) == 5172, 'Use the pinned Telegram Web artwork, see assets/emoji/README.md'
sequences = {}
images = {}
digest = hashlib.sha256()
for path in files:
    data = path.read_bytes()
    digest.update(path.name.encode() + b'\0' + data)
    image = Image.open(BytesIO(data))
    assert image.size == (64, 64)
    # Lossless re-encoding drops redundant PNG metadata; aliases share one bitmap glyph.
    output = BytesIO()
    image.save(output, format='PNG', optimize=True)
    png = output.getvalue()
    key = hashlib.sha256(png).hexdigest()
    name = 'emoji_' + key[:20]
    images[name] = png
    seq = tuple(int(cp, 16) for cp in path.stem.split('-'))
    sequences[seq] = name
    sequences.setdefault(tuple(cp for cp in seq if cp != 0xFE0F), name)
assert digest.hexdigest() == 'c61417cbdd2418658351dc3f2897d48a07b4bd0b994273d88977505e2c45da23', (
    'Artwork differs from the pinned Telegram Web source; review it before updating'
)

codepoints = sorted({cp for seq in sequences for cp in seq})
cmap = {cp: sequences.get((cp,), f'u{cp:06X}') for cp in codepoints}
order = ['.notdef'] + sorted(set(cmap.values()) | set(images))
builder = FontBuilder(1024, isTTF=True)
builder.setupGlyphOrder(order)
builder.setupCharacterMap(cmap)
glyphs = {}
for name in order:
    pen = TTGlyphPen(None)
    # Non-empty bounds let Chromium/Skia discover the sbix bitmap. The bitmap paints
    # over this outline; the empty component glyphs (ZWJ/VS/keycap bases) stay invisible.
    if name in images:
        pen.moveTo((0, -192))
        pen.lineTo((1024, -192))
        pen.lineTo((1024, 832))
        pen.lineTo((0, 832))
        pen.closePath()
    glyphs[name] = pen.glyph()
builder.setupGlyf(glyphs)
builder.setupHorizontalMetrics({name: (1024 if name in images else 0, 0) for name in order})
builder.setupHorizontalHeader(ascent=832, descent=-192)
builder.setupNameTable({
    'familyName': 'TGW Telegram Emoji', 'styleName': 'Regular',
    'uniqueFontIdentifier': 'TGW Telegram Emoji 293ede7b',
    'fullName': 'TGW Telegram Emoji', 'psName': 'TGWTelegramEmoji',
    'version': 'Version 1.000',
    'copyright': 'Default emoji artwork from Telegram Web A; see assets/emoji/README.md',
})
builder.setupOS2(sTypoAscender=832, sTypoDescender=-192, usWinAscent=832, usWinDescent=192)
builder.setupPost()
font = builder.font
font['head'].created = font['head'].modified = 3877632000
font.recalcTimestamp = False
font['sbix'] = newTable('sbix')
strike = Strike(ppem=64, resolution=72)
for name, png in images.items():
    strike.glyphs[name] = Glyph(glyphName=name, originOffsetX=0, originOffsetY=-12,
                               graphicType='png ', imageData=png)
font['sbix'].strikes = {64: strike}
# Required ligatures keep families, skin tones, keycaps, flags and variation selectors
# as one glyph, even if the host turns optional text ligatures off.
features = ['languagesystem DFLT dflt;', 'languagesystem latn dflt;', 'feature rlig {']
for seq, name in sorted(sequences.items(), key=lambda item: (-len(item[0]), item[0])):
    if len(seq) > 1:
        features.append('sub ' + ' '.join(cmap[cp] for cp in seq) + ' by ' + name + ';')
features.append('} rlig;')
addOpenTypeFeaturesFromString(font, '\n'.join(features))
font.flavor = 'woff2'
destination = Path(__file__).resolve().parents[1] / 'webapp/src/fonts/TelegramEmoji.woff2'
font.save(destination)
print(f'Wrote {destination} ({len(images)} bitmaps, {len(sequences)} sequences, {destination.stat().st_size:,} bytes)')
