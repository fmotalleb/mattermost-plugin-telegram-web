#!/usr/bin/env bash
set -euo pipefail

# Remove leading whitespace and UTF-8 encoded invisible formatting characters
# that can precede PHP source (for example a BOM or zero-width space).
root=${1:-.}

if [[ ! -d "$root" ]]; then
  printf 'Not a directory: %s\n' "$root" >&2
  exit 2
fi

find "$root" -type f -iname '*.php' -print0 |
  while IFS= read -r -d '' file; do
    pattern='(?:[\x20\t\r\n]|\xEF\xBB\xBF|\xE2\x80[\x8B-\x8F]|\xE2\x80[\xAA-\xAE]|\xE2\x81[\xA0-\xAF])'
    if perl -0777 -ne "exit(\$_ =~ /\\A(?:$pattern)+/ ? 0 : 1)" "$file"; then
      perl -0777 -i -pe "s/\\A(?:$pattern)+//" "$file"
      printf 'Cleaned: %s\n' "$file"
    fi
  done
