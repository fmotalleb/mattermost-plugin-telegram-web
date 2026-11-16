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

The font is embedded in the single JS bundle with no CDN or OS emoji dependency.
COLRv0 is supported by modern Chromium, Firefox and Safari, including native text
fields. To reproduce the font, install `fonttools[woff]` in a temporary Python
environment and run:

```sh
python scripts/prepare-emoji-font.py /path/to/twemoji-colrv0.ttf
```
