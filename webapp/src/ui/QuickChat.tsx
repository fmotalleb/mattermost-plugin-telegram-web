import React, {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {api} from '../mm/api';
import {useSelector} from '../mm/store';
import type {MMChannel} from '../mm/types';
import {ChatView} from './ChatView';
import {TgContext, useTg} from './context';
import {overlayRoot} from './portal';
import {IconClose} from './primitives';

export function QuickChat({channelId}: {channelId: string}) {
    const parent = useTg();
    const stored = useSelector((state) => state.entities?.channels?.channels?.[channelId]);
    const [fetched, setFetched] = useState<MMChannel>();
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const dialog = useRef<HTMLDivElement>(null);
    const latest = useRef(parent);
    latest.current = parent;
    const close = () => latest.current.actions.setUI({quickChatId: undefined});
    useEffect(() => {
        if (stored) return;
        let cancelled = false;
        setError(false);
        api.getChannel(channelId).then((channel) => {
            if (!cancelled) setFetched(channel);
        }).catch(() => { if (!cancelled) setError(true); });
        return () => { cancelled = true; };
    }, [channelId, stored, attempt]);

    useEffect(() => {
        const previous = document.activeElement as HTMLElement;
        const shell = document.querySelector('.tgw-shell') as HTMLElement;
        const wasInert = shell?.inert;
        if (shell) shell.inert = true;
        const initialInput = dialog.current?.querySelector<HTMLTextAreaElement>('textarea');
        if (initialInput) initialInput.focus();
        else dialog.current?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (latest.current.ui.imageViewer) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                close();
            }
            if (event.key === 'Tab') {
                const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]') || []).filter((node) => node.getClientRects().length > 0);
                const index = nodes.indexOf(document.activeElement as HTMLElement);
                if (!nodes.length) { event.preventDefault(); dialog.current?.focus(); }
                else if (event.shiftKey && index <= 0) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
                else if (!event.shiftKey && (index === nodes.length - 1 || index < 0)) { event.preventDefault(); nodes[0].focus(); }
            }
        };
        const onFocus = (event: FocusEvent) => {
            if (latest.current.ui.imageViewer) return;
            const target = event.target as Node;
            if (!dialog.current?.contains(target)) {
                const input = dialog.current?.querySelector<HTMLTextAreaElement>('textarea');
                if (input) input.focus();
                else dialog.current?.focus();
            }
        };
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('focusin', onFocus);
        return () => {
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('focusin', onFocus);
            if (shell) shell.inert = wasInert;
            if (previous?.isConnected) previous.focus();
        };
    }, []);

    const channel = stored || fetched;
    const value = {
        ...parent,
        channel,
        isMobile: false,
        ui: {...parent.ui, selectedChannelId: channelId, replyTo: null, editing: null, highlightedPostId: null, threadRootId: null},
        actions: {...parent.actions, startReply: () => undefined, startEditing: () => undefined, openContextMenu: () => undefined, openReactionPicker: () => undefined, openUserChat: () => undefined},
    };
    return createPortal(
        <div className="tgw-quick-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && event.button === 0) close(); }}>
            <div className="tgw-quick-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Quick chat">
                <button className="tgw-icon-button tgw-quick-close" type="button" title="Close quick chat" aria-label="Close quick chat" onClick={close}><IconClose size={22}/></button>
                {channel ? <TgContext.Provider value={value}><ChatView quick/></TgContext.Provider> :
                    <div className="tgw-quick-loading">{error ? <><span role="alert">Could not open chat.</span><button type="button" onClick={() => setAttempt((n) => n + 1)}>Retry</button></> : 'Loading chat…'}</div>}
            </div>
        </div>, overlayRoot(),
    );
}
