# Telegram default emoji artwork

The Telegram view bundles the same default Apple-style PNG artwork shipped by
Telegram Web A, rather than depending on installed operating-system emoji fonts.
Custom Mattermost emoji keep their workspace-provided images.

- Upstream: https://github.com/Ajaxy/telegram-tt
- Pinned commit: `293ede7b20390d04934f4beee6304c3560bbb5d6`.
- Artwork: `dist/img-apple-64/*.png` (5,172 source files, including aliases).
- SHA-256 of the sorted source filenames and bytes (as checked by the build script):
  `c61417cbdd2418658351dc3f2897d48a07b4bd0b994273d88977505e2c45da23`.
- Telegram's emoji data dependency: `korenskoy/emoji-data-ios` at
  `73efe6b65daa36dd6ec188d71ef4f06f78634c5f`.
- Original artwork belongs to its respective owners; Telegram Web's upstream
  license is included as [LICENSE-TELEGRAM](LICENSE-TELEGRAM).

`webapp/src/fonts/TelegramEmoji.woff2` repackages the original 64px artwork into an
sbix bitmap font. Pixels are preserved; duplicate images are shared, PNG metadata
is removed, and Unicode ligatures map flags, skin tones, keycaps and ZWJ sequences
to the appropriate images. The font is embedded in the plugin's single JS bundle
and also works in text fields, without external image requests.

To reproduce it, obtain the pinned upstream checkout, install `fonttools[woff]`
and Pillow in a temporary Python environment, then run:

```sh
python scripts/prepare-emoji-font.py /path/to/telegram-tt/dist/img-apple-64
```

The ordinary text font comes first so spaces, digits, `#`, and `*` remain normal
text; emoji controls and message emoji wrappers explicitly select the artwork font.
