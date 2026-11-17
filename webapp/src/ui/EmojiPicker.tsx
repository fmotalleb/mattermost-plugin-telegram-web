import React, {useRef} from 'react';
import {deferred} from './deferred';
import type {EmojiPickerProps} from './EmojiPickerContent';
export type {EmojiPickerProps} from './EmojiPickerContent';
const Picker = deferred(() => import(/* webpackChunkName: "emoji-picker" */ './EmojiPickerContent').then((module) => module.EmojiPicker), 'emoji picker');
export function EmojiPicker(props: EmojiPickerProps) {
    const root = useRef<HTMLDivElement>(null);
    React.useLayoutEffect(() => {
        const closeOutside = (event: MouseEvent) => {
            const target = event.target as Element;
            if (target && !root.current?.contains(target) && !target.closest('button[title="Emoji"]')) props.onClose();
        };
        document.addEventListener('mousedown', closeOutside, true);
        return () => document.removeEventListener('mousedown', closeOutside, true);
    }, [props.onClose]);
    return <div ref={root} style={{display: 'contents'}}><Picker {...props}/></div>;
}
