// Telegram-style dropdown / context menu rendered in a portal.

import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {overlayRoot} from './portal';

export interface MenuItem {
    key: string;
    label: string;
    icon?: React.ReactNode;
    danger?: boolean;
    checked?: boolean;
    disabled?: boolean;
    /** Native tooltip shown on hover — the reactor rows use it for "full name · reaction time". */
    title?: string;
    onClick?: () => void;
}

export interface MenuEmojiPick {
    name: string;
    char: string;
}

/**
 * One row of bare emoji (Telegram's quick-reaction strip on top of the post menu): no labels,
 * each emoji is its own button; `active` marks the ones the user already joined.
 */
export interface EmojiRowEntry {
    key: string;
    kind: 'emoji-row';
    emojis: MenuEmojiPick[];
    active?: (name: string) => boolean;
    onPick: (name: string) => void;
}

export type MenuEntry = MenuItem | EmojiRowEntry | 'separator';

/** Runtime-checkable discriminator for the render below (MenuItem carries no `kind` field). */
function isEmojiRow(item: MenuItem | EmojiRowEntry): item is EmojiRowEntry {
    return typeof (item as EmojiRowEntry).kind === 'string' && (item as EmojiRowEntry).kind === 'emoji-row';
}

export interface MenuProps {
    x: number;
    y: number;
    items: MenuEntry[];
    onClose: () => void;
    width?: number;
    align?: 'left' | 'right';
}

export function Menu({x, y, items, onClose, width = 220, align = 'left'}: MenuProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState({left: x, top: y});

    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) {
            return;
        }
        const rect = element.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        let left = align === 'right' ? x - rect.width : x;
        let top = y;
        if (left + rect.width > viewportWidth - 8) {
            left = Math.max(8, viewportWidth - rect.width - 8);
        }
        if (left < 8) {
            left = 8;
        }
        if (top + rect.height > viewportHeight - 8) {
            top = Math.max(8, viewportHeight - rect.height - 8);
        }
        setPosition({left, top});
    }, [x, y, align, width]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                onClose();
            }
        };
        const onPointerDown = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('mousedown', onPointerDown, true);
        return () => {
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('mousedown', onPointerDown, true);
        };
    }, [onClose]);

    // Portal into the overlay root so the menu inherits the --tgw-* theme variables
    // (background, border, shadow) - see portal.ts.
    const container = overlayRoot();

    return createPortal(
        <div
            ref={ref}
            className="tgw-menu"
            style={{left: position.left, top: position.top, width}}
            role="menu"
        >
            {items.map((item, index) => {
                if (item === 'separator') {
                    return <div key={`sep-${index}`} className="tgw-menu-separator"/>;
                }
                if (isEmojiRow(item)) {
                    return (
                        <div key={item.key} className="tgw-menu-emoji-row" role="group">
                            {item.emojis.map((emoji) => {
                                const active = !!item.active && item.active(emoji.name);
                                return (
                                    <button
                                        key={emoji.name}
                                        type="button"
                                        role="menuitem"
                                        aria-label={`React with ${emoji.name}`}
                                        aria-pressed={active}
                                        className={`tgw-menu-emoji ${active ? 'tgw-menu-emoji-active' : ''}`}
                                        onClick={() => {
                                            onClose();
                                            item.onPick(emoji.name);
                                        }}
                                    >
                                        {emoji.char}
                                    </button>
                                );
                            })}
                        </div>
                    );
                }
                const entry: MenuItem = item;
                return (
                    <button
                        key={entry.key}
                        type="button"
                        role="menuitem"
                        disabled={entry.disabled}
                        title={entry.title}
                        className={`tgw-menu-item ${entry.danger ? 'tgw-menu-item-danger' : ''}`}
                        onClick={() => {
                            onClose();
                            entry.onClick?.();
                        }}
                    >
                        {entry.icon && <span className="tgw-menu-item-icon">{entry.icon}</span>}
                        <span className="tgw-menu-item-label">{entry.label}</span>
                        {entry.checked && <span className="tgw-menu-item-check">✓</span>}
                    </button>
                );
            })}
        </div>,
        container,
    );
}

export function menuPositionFromEvent(event: {clientX: number; clientY: number}): {x: number; y: number} {
    return {x: event.clientX, y: event.clientY};
}

export function menuPositionFromElement(element: HTMLElement | null, align: 'left' | 'right' = 'left'): {x: number; y: number} {
    if (!element) {
        return {x: 10, y: 10};
    }
    const rect = element.getBoundingClientRect();
    return {x: align === 'right' ? rect.right : rect.left, y: rect.bottom + 6};
}
