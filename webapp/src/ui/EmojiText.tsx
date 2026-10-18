// Plain-text message excerpts (chat row previews, reply bars, search hits) rendered with the
// emoji they carry.
//
// System shortcodes are already unicode by the time they get here (toPlainPreview runs
// replaceShortcodes). *Custom* emoji uploaded to the server have no unicode character at all, so
// they are drawn as the small image Mattermost serves for them: looked up in the host store
// first, then — once per name — through GET /emojios/name/{name}. A name that resolves to
// neither stays exactly as typed, so unknown text is never hidden or reworded.

import React, {useEffect, useMemo, useState} from 'react';
import {api} from '../mm/api';
import {emojiChar} from '../mm/emoji';
import {getCustomEmoji} from '../mm/selectors';
import {useSelector} from '../mm/store';
import type {MMCustomEmoji} from '../mm/types';

/** name → emoji id; a null value records "the server has no such custom emoji". */
const customIds = new Map<string, string | null>();
/** names with a lookup in flight, so a busy preview never doubles a request. */
const looking = new Set<string>();
/** mounted previews re-render when a lookup lands. */
const watchers = new Set<() => void>();

function notifyWatchers() {
    watchers.forEach((watcher) => watcher());
}

/**
 * truncate() cuts at a fixed length and appends "…", which can bite an emoji shortcode in half
 * (`:party_par…`). A half name would render as literal text, so the fragment goes with the rest
 * of the cut. Only applies to already-truncated text (it ends with "…") and needs a few
 * characters after the colon, so "10:3…" style tails are left alone.
 */
function trimCutShortcode(text: string): string {
    if (!text || !text.endsWith('…')) {
        return text;
    }
    return text.replace(/:[\w+-]{3,}…$/, '…');
}

/** Case-insensitive highlight of the search term, copied from the wide search panel's marks. */
function highlight(chunk: string, term?: string): React.ReactNode {
    if (!term || !chunk) {
        return chunk;
    }
    const parts: React.ReactNode[] = [];
    const lower = chunk.toLowerCase();
    const needle = term.toLowerCase();
    let index = 0;
    let key = 0;
    for (;;) {
        const at = lower.indexOf(needle, index);
        if (at === -1) {
            break;
        }
        if (at > index) {
            parts.push(chunk.slice(index, at));
        }
        parts.push(<mark key={key++} className="tgw-search-mark">{chunk.slice(at, at + needle.length)}</mark>);
        index = at + needle.length;
    }
    if (index < chunk.length) {
        parts.push(chunk.slice(index));
    }
    return <>{parts}</>;
}

export interface EmojiTextProps {
    text: string;
    /** Highlights this term inside the plain-text parts (message search hits). */
    term?: string;
    className?: string;
}

export function EmojiText({text, term, className}: EmojiTextProps) {
    const customEmoji = useSelector(getCustomEmoji);
    // Mattermost keys this record by id on some releases and by name on others: index entries by
    // the emoji's own `name` so both shapes work, rebuilt only when the record itself changes.
    const idsByName = useMemo(() => {
        const map: Record<string, string> = {};
        Object.values(customEmoji || {}).forEach((emoji: MMCustomEmoji) => {
            if (emoji && emoji.name && emoji.id) {
                map[emoji.name] = emoji.id;
            }
        });
        return map;
    }, [customEmoji]);
    const [, bump] = useState(0);

    useEffect(() => {
        const listener = () => bump((value) => value + 1);
        watchers.add(listener);
        return () => {
            watchers.delete(listener);
        };
    }, []);

    const source = trimCutShortcode(text || '');
    // Alternating plain/name parts: the capture group survives the split.
    const parts = source.split(/:([\w+-]+):/);
    const unknown: string[] = [];
    const nodes: React.ReactNode[] = [];

    parts.forEach((part, index) => {
        if (index % 2 === 0) {
            if (part) {
                nodes.push(<React.Fragment key={`t${index}`}>{highlight(part, term)}</React.Fragment>);
            }
            return;
        }
        const name = part;
        const known = idsByName[name] !== undefined ? idsByName[name] : (customIds.has(name) ? customIds.get(name) : undefined);
        if (known) {
            nodes.push(
                <img
                    key={`e${index}`}
                    className="tgw-inline-emoji"
                    src={api.customEmojiImageURL(known)}
                    alt={`:${name}:`}
                    title={`:${name}:`}
                />,
            );
            return;
        }
        const char = emojiChar(name);
        if (char) {
            nodes.push(<React.Fragment key={`c${index}`}>{char}</React.Fragment>);
            return;
        }
        if (!customIds.has(name) && !looking.has(name)) {
            unknown.push(name);
        }
        nodes.push(<React.Fragment key={`s${index}`}>{highlight(`:${name}:`, term)}</React.Fragment>);
    });

    // Ask the server about names the host store does not carry — one lookup per distinct name.
    useEffect(() => {
        unknown.forEach((name) => {
            if (looking.has(name) || customIds.has(name)) {
                return;
            }
            looking.add(name);
            api.getCustomEmojiByName(name)
                .then((emoji) => {
                    customIds.set(name, emoji && emoji.id ? emoji.id : null);
                })
                .catch(() => {
                    // Unknown custom emoji, no license for them, or the call failed: keep the
                    // name as typed and do not ask again for this session.
                    customIds.set(name, null);
                })
                .then(() => {
                    looking.delete(name);
                    notifyWatchers();
                });
        });
    }, [source, idsByName]);

    return <span className={className}>{nodes}</span>;
}