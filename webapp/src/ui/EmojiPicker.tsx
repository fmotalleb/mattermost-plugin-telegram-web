// Emoji picker (unicode set + the instance's custom emoji).

import React, {useEffect, useMemo, useRef, useState} from 'react';
import {api} from '../mm/api';
import {EMOJI_CATEGORIES, searchEmoji} from '../mm/emoji';
import {getCustomEmoji} from '../mm/selectors';
import {readLocal, useSelector, writeLocal} from '../mm/store';
import type {MMCustomEmoji} from '../mm/types';
import {useTg} from './context';

const RECENT_KEY = 'tgw.recent.emoji';

function readRecent(): string[] {
    try {
        const parsed = JSON.parse(readLocal(RECENT_KEY, '[]'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        return [];
    }
}

export interface EmojiPickerProps {
    onPick: (emojiName: string) => void;
    onClose: () => void;
}

export function EmojiPicker({onPick, onClose}: EmojiPickerProps) {
    const {ui} = useTg();
    const [term, setTerm] = useState('');
    const [recent, setRecent] = useState<string[]>(readRecent);
    const customEmoji = useSelector(getCustomEmoji);
    const [activeCategory, setActiveCategory] = useState(EMOJI_CATEGORIES[0].id);
    const bodyRef = useRef<HTMLDivElement>(null);
    const pickerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const closeOutside = (event: MouseEvent) => {
            const target = event.target as Element | null;
            if (target && !pickerRef.current?.contains(target) && !target.closest('button[title="Emoji"]')) {
                onClose();
            }
        };
        document.addEventListener('mousedown', closeOutside, true);
        return () => document.removeEventListener('mousedown', closeOutside, true);
    }, [onClose]);

    const isDark = ui.selectedChannelId ? undefined : undefined;

    const customList = useMemo(() => Object.values(customEmoji || {}) as MMCustomEmoji[], [customEmoji]);
    const results = useMemo(() => searchEmoji(term), [term]);

    const pick = (name: string) => {
        const next = [name, ...recent.filter((entry) => entry !== name)].slice(0, 24);
        setRecent(next);
        writeLocal(RECENT_KEY, JSON.stringify(next));
        onPick(name);
    };

    const scrollToCategory = (categoryId: string) => {
        setActiveCategory(categoryId);
        const target = bodyRef.current?.querySelector(`[data-category="${categoryId}"]`);
        if (target) {
            (target as HTMLElement).scrollIntoView({block: 'start'});
        }
    };

    return (
        <div ref={pickerRef} className="tgw-emoji-picker" onMouseDown={(event) => event.preventDefault()}>
            <div className="tgw-emoji-header">
                <input
                    autoFocus
                    value={term}
                    onChange={(event) => setTerm(event.target.value)}
                    placeholder="Search emoji"
                    spellCheck={false}
                />
                <button type="button" className="tgw-emoji-close" onClick={onClose} title="Close">
                    ×
                </button>
            </div>

            {term ? (
                <div className="tgw-emoji-body" ref={bodyRef}>
                    <div className="tgw-emoji-grid">
                        {results.map((emoji) => (
                            <button type="button" key={emoji.name} title={`:${emoji.name}:`} onClick={() => pick(emoji.name)}>
                                {emoji.char}
                            </button>
                        ))}
                    </div>
                    {!results.length && <div className="tgw-emoji-empty">No emoji found</div>}
                </div>
            ) : (
                <>
                    <div className="tgw-emoji-tabs">
                        <button type="button" className={activeCategory === 'recent' ? 'active' : ''} onClick={() => scrollToCategory('recent')} title="Frequently used">
                            🕘
                        </button>
                        {EMOJI_CATEGORIES.map((category) => (
                            <button
                                type="button"
                                key={category.id}
                                className={activeCategory === category.id ? 'active' : ''}
                                onClick={() => scrollToCategory(category.id)}
                                title={category.label}
                            >
                                {category.icon}
                            </button>
                        ))}
                        <button
                            type="button"
                            className={activeCategory === 'custom' ? 'active' : ''}
                            onClick={() => scrollToCategory('custom')}
                            title="Custom emoji"
                        >
                            ⭐
                        </button>
                    </div>
                    <div className="tgw-emoji-body" ref={bodyRef}>
                        {recent.length > 0 && (
                            <div data-category="recent">
                                <div className="tgw-emoji-section">Frequently used</div>
                                <div className="tgw-emoji-grid">
                                    {recent.map((name) => {
                                        const custom = customEmoji?.[name];
                                        if (custom) {
                                            return (
                                                <button type="button" key={name} title={`:${name}:`} onClick={() => pick(name)}>
                                                    <img src={api.customEmojiImageURL(custom.id)} alt={`:${name}:`}/>
                                                </button>
                                            );
                                        }
                                        const entry = findEmojiChar(name);
                                        return (
                                            <button type="button" key={name} title={`:${name}:`} onClick={() => pick(name)}>
                                                {entry || `:${name}:`}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        {customList.length > 0 && (
                            <div data-category="custom">
                                <div className="tgw-emoji-section">Custom emoji</div>
                                <div className="tgw-emoji-grid">
                                    {customList.slice(0, 200).map((emoji) => (
                                        <button type="button" key={emoji.id} title={`:${emoji.name}:`} onClick={() => pick(emoji.name)}>
                                            <img src={api.customEmojiImageURL(emoji.id)} alt={`:${emoji.name}:`} loading="lazy"/>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                        {EMOJI_CATEGORIES.map((category) => (
                            <div key={category.id} data-category={category.id}>
                                <div className="tgw-emoji-section">{category.label}</div>
                                <div className="tgw-emoji-grid">
                                    {category.emojis.map((emoji) => (
                                        <button type="button" key={`${category.id}-${emoji.name}-${emoji.char}`} title={`:${emoji.name}:`} onClick={() => pick(emoji.name)}>
                                            {emoji.char}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </>
            )}
            {/* eslint-disable-next-line @typescript-eslint/no-unused-vars */}
            <span style={{display: 'none'}}>{String(isDark)}</span>
        </div>
    );
}

function findEmojiChar(name: string): string | undefined {
    for (const category of EMOJI_CATEGORIES) {
        const found = category.emojis.find((emoji) => emoji.name === name);
        if (found) {
            return found.char;
        }
    }
    return undefined;
}
