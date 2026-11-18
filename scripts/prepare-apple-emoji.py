"""Rebuild the optional Apple emoji sprites from the pinned emoji-data sources.

Requires Pillow with WebP support. Usage: python scripts/prepare-apple-emoji.py sheet.png emoji.json
The source files and their hashes are documented in assets/emoji/README.md.
"""
import hashlib
import json
import sys
from pathlib import Path
from PIL import Image

sheet, metadata = map(Path, sys.argv[1:3])
assert hashlib.sha256(sheet.read_bytes()).hexdigest() == 'a2918c190c085cceb242a8078e8442176c446a247d8f3acd0e92b141a7a0fb61'
assert hashlib.sha256(metadata.read_bytes()).hexdigest() == '8736d721991e48c41c57acc46b65e5d32258a45e4bcdebcc6012f420f81e775d'
out = Path(__file__).resolve().parents[1] / 'webapp/src/emoji'
out.mkdir(parents=True, exist_ok=True)
im = Image.open(sheet)
assert im.size == (4158, 4158)
for y in range(2):
    for x in range(2):
        im.crop((x * 2112, y * 2112, min((x + 1) * 2112, 4158), min((y + 1) * 2112, 4158))).save(out / f'apple-{x}-{y}.webp', 'WEBP', lossless=True, method=4)
mapping = {}
for entry in json.loads(metadata.read_text()):
    for item in [entry, *entry.get('skin_variations', {}).values()]:
        if not item.get('has_img_apple'):
            continue
        for key in ('unified', 'non_qualified'):
            if item.get(key):
                sequence = ''.join(chr(int(code, 16)) for code in item[key].split('-')).replace('\ufe0f', '')
                mapping[sequence] = [item['sheet_x'], item['sheet_y']]
(out / 'apple-map.json').write_text(json.dumps(mapping, ensure_ascii=False, separators=(',', ':')))
