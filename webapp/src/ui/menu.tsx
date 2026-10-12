// Telegram-style dropdown / context menu rendered in a portal.

import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

export interface MenuItem {
    key: string;
    label: string;
    icon?: React.ReactNode;
    danger?: boolean;
    checked?: boolean;
    disabled?: boolean;
    onClick?: () => void;
}

export type MenuEntry = MenuItem | 'separator';

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
                return (
                    <button
                        key={item.key}
                        type="button"
                        role="menuitem"
                        disabled={item.disabled}
                        className={`tgw-menu-item ${item.danger ? 'tgw-menu-item-danger' : ''}`}
                        onClick={() => {
                            onClose();
                            item.onClick?.();
                        }}
                    >
                        {item.icon && <span className="tgw-menu-item-icon">{item.icon}</span>}
                        <span className="tgw-menu-item-label">{item.label}</span>
                        {item.checked && <span className="tgw-menu-item-check">✓</span>}
                    </button>
                );
            })}
        </div>,
        document.body,
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
