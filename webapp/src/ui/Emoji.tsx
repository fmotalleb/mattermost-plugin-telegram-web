import React from 'react';
import appleMap from '../emoji/apple-map.json';

// Keep the Unicode text in the DOM for copy/paste and assistive technology. The optional
// sprite is painted only for sequences present in the Apple sheet; others use the font.
export function Emoji({char, className = 'tgw-emoji', title}: {char: string; className?: string; title?: string}) {
    const position: number[] | undefined = (appleMap as Record<string, number[]>)[char.replace(/\ufe0f/g, '')];
    const style = position ? {
        '--tgw-emoji-x': `${-((position[0] % 32) * 66 + 1) / 64}em`,
        '--tgw-emoji-y': `${-((position[1] % 32) * 66 + 1) / 64}em`,
    } as React.CSSProperties : undefined;
    return <span className={`${className}${position ? ` tgw-apple-emoji tgw-apple-${Math.floor(position[0] / 32)}-${Math.floor(position[1] / 32)}` : ''}`} style={style} title={title}>{char}</span>;
}
