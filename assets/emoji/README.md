# Bundled vector emoji artwork

The Telegram view uses Twemoji vector artwork by Twitter and the Twemoji
contributors (Jason Sofonia and Justine De Caires), licensed under CC BY 4.0.
The COLRv0 font contains colored vector outlines, not embedded PNGs, so emoji
stay sharp at different sizes, zoom levels and device pixel ratios.

- Artwork: https://github.com/jdecked/twemoji (Emoji 17.0).
- Font build: https://github.com/iebb/emojifonts/releases/tag/latest
  (release published 2026-06-16).
- Download: https://github.com/iebb/emojifonts/releases/download/latest/twemoji-colrv0.ttf
- Original SHA-256: `14f379d101936cb0a57c5fa5606c6ca3bd14f117dcc37d10b8a8ad58199fdefa`.
- Artwork license: [LICENSE-GRAPHICS](LICENSE-GRAPHICS).
- Upstream code notice: [LICENSE](LICENSE).

`webapp/src/fonts/Twemoji.woff2` is a modified, compressed copy: existing keycap
digit mappings were restored, layer bearings corrected to preserve their positions,
and baseline metrics corrected to contain the glyph inside a single em.
No artwork was redrawn. Ordinary English/Persian text and
ASCII still use the text font. Emoji wrappers reserve one square em of the
surrounding font size; complex sequences remain one glyph/cell. Custom Mattermost
emoji retain their images and fit inside the same square without stretching.

The font is a separately packaged local asset with no CDN or OS emoji dependency.
COLRv0 is supported by modern Chromium, Firefox and Safari, including native text
fields. To reproduce the font, install `fonttools[woff]` in a temporary Python
environment and run:

```sh
python scripts/prepare-emoji-font.py /path/to/twemoji-colrv0.ttf
```

## Optional Apple artwork

The optional “Use Apple emoji artwork” setting uses the same Apple image source
[documented by Telegram Web K](https://github.com/TelegramOrg/Telegram-web-k/blob/master/EMOJI.md).
It is disabled by default. The Apple images are copyright Apple Inc.; the source
states they are **not licensed for commercial use**. The switch does not grant
any rights to use or redistribute them. Deployment operators must determine and
obtain the rights they need before distributing or enabling the artwork.

The original 64-pixel clean sheet and its matching sequence metadata come from
[emoji-data](https://github.com/iamcal/emoji-data); its repository license does
not grant a license to Apple artwork. The pinned inputs are:

- `sheets-clean/sheet_apple_64_clean.png` SHA-256 `a2918c190c085cceb242a8078e8442176c446a247d8f3acd0e92b141a7a0fb61`.
- `emoji.json` SHA-256 `8736d721991e48c41c57acc46b65e5d32258a45e4bcdebcc6012f420f81e775d` (mapping revision `5cbb9b2a95fea05967f9b345cf56df4cbd0aebb8`).

Run `python scripts/prepare-apple-emoji.py sheet.png emoji.json` with Pillow and
WebP support to regenerate the four lossless sheets and Unicode mapping. Each
sheet is requested only when the option is enabled and a matching emoji appears.
Sequences absent from the Apple sheet retain the vector font fallback. Composer
text fields and code blocks continue using fonts because they must remain editable
or literal.
