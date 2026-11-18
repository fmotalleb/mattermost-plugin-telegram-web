import React, {useEffect, useMemo, useRef, useState} from 'react';
import {api} from '../mm/api';
import type {MMUser} from '../mm/types';
import {displayName} from '../mm/utils';
import {Avatar} from './primitives';

function mentionAt(text: string, caret: number) {
    const match = text.slice(0, caret).match(/(?:^|[\s([{])@([\w.-]*)$/u);
    if (!match) return null;

    const query = match[1];
    const start = caret - query.length - 1;
    const prefix = text.slice(0, start);
    // Follow Markdown's matching delimiter lengths, including unclosed code while composing.
    let fence = '';
    let backticks = '';
    for (const delimiter of prefix.matchAll(/^ {0,3}(`{3,}|~{3,})[^\r\n]*|(?<!\\)(`+)/gm)) {
        const block = delimiter[1];
        if (block) {
            if (!fence) fence = block;
            else if (block[0] === fence[0] && block.length >= fence.length && delimiter[0].trim() === block) fence = '';
            backticks = '';
        } else if (!fence) {
            if (!backticks) backticks = delimiter[2];
            else if (backticks === delimiter[2]) backticks = '';
        }
    }
    if (fence || backticks) return null;

    const tail = text.slice(caret).match(/^[\w.-]*/)[0].replace(/\.+$/, '');
    return {start, end: caret + tail.length, query};
}

export function useMentionAutocomplete(message: string, channelId: string, teamId: string, editId: string | undefined, enabled: boolean, insert: (message: string, caret: number) => void) {
    const [selection, setSelection] = useState<{
        text: string;
        channelId: string;
        editId: string | undefined;
        token: NonNullable<ReturnType<typeof mentionAt>>;
    } | null>(null);
    const [index, setIndex] = useState(0);
    const [retry, setRetry] = useState(0);
    const dismissed = useRef<{text: string; caret: number; channelId: string; editId: string | undefined} | null>(null);
    const id = useMemo(() => `tgw-mentions-${Math.random().toString(36).slice(2)}`, []);
    const optionsId = `${id}-options`;
    const token = enabled && selection?.text === message && selection.channelId === channelId && selection.editId === editId
        ? selection.token : null;
    const query = token?.query ?? null;
    const request = useMemo(() => query === null ? null : {query, channelId, teamId, retry}, [query, channelId, teamId, retry]);
    const [result, setResult] = useState<{request: typeof request; users: MMUser[]; failed: boolean} | null>(null);
    const current = result?.request === request ? result : null;
    const users = current?.users || [];
    const active = users[index] || users[0];

    useEffect(() => {
        if (!request) return undefined;

        let cancelled = false;
        setIndex(0);
        const timer = setTimeout(async () => {
            try {
                const {users: matches = []} = await api.autocompleteUsers(request.query, request.teamId, request.channelId);
                if (cancelled) return;

                // The endpoint scopes users to the channel. The host's Redux cache can omit
                // channel members even when the server has already returned them.
                const unique = new Map<string, MMUser>();
                matches.forEach((user) => {
                    if (user.id && user.username && !user.delete_at && !unique.has(user.id)) unique.set(user.id, user);
                });
                setResult({request, users: [...unique.values()], failed: false});
            } catch {
                if (!cancelled) setResult({request, users: [], failed: true});
            }
        }, 150);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [request]);

    const activeId = active && `${id}-${active.id}`;
    useEffect(() => {
        if (activeId) document.getElementById(activeId)?.scrollIntoView?.({block: 'nearest'});
    }, [activeId]);

    const dismiss = () => setSelection(null);
    const updateSelection = (area: HTMLTextAreaElement) => {
        const closed = dismissed.current;
        if (closed?.text === area.value && closed.caret === area.selectionStart &&
            area.selectionStart === area.selectionEnd && closed.channelId === channelId && closed.editId === editId) {
            return;
        }
        dismissed.current = null;
        const candidate = area.selectionStart === area.selectionEnd ? mentionAt(area.value, area.selectionStart) : null;
        setSelection(candidate ? {text: area.value, channelId, editId, token: candidate} : null);
    };
    const choose = (user: MMUser) => {
        if (!token) return;

        const following = message.slice(token.end);
        const mention = `@${user.username}`;
        const separator = /^[\s.,:;!?)}\]]/.test(following) ? '' : ' ';
        const caret = token.start + mention.length + (following.startsWith(' ') ? 1 : separator.length);
        dismiss();
        insert(message.slice(0, token.start) + mention + separator + following, caret);
    };
    const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!token || event.nativeEvent.isComposing) return false;
        if (event.key === 'Escape') {
            event.preventDefault();
            dismissed.current = {text: message, caret: event.currentTarget.selectionStart, channelId, editId};
            dismiss();
            return true;
        }
        if (!active || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const offset = event.key === 'ArrowDown' ? 1 : -1;
            setIndex((users.indexOf(active) + offset + users.length) % users.length);
            return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            choose(active);
            return true;
        }
        return false;
    };
    const onBlur = (target: EventTarget | null) => {
        if (!(target instanceof Node) || !document.getElementById(id)?.contains(target)) dismiss();
    };

    const picker = token && (
        <div className="tgw-mention-picker" id={id}>
            {!current && <div className="tgw-mention-message" role="status">Searching…</div>}
            {current?.failed && (
                <button
                    type="button"
                    className="tgw-mention-message tgw-mention-retry"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                        event.currentTarget.closest('.tgw-composer')?.querySelector('textarea')?.focus();
                        setRetry((value) => value + 1);
                    }}
                    onBlur={(event) => {
                        if (!(event.relatedTarget instanceof HTMLTextAreaElement)) onBlur(event.relatedTarget);
                    }}
                >Search failed. Retry</button>
            )}
            {current && !current.failed && !users.length && <div className="tgw-mention-message" role="status">No matching channel members</div>}
            {!!users.length && (
                <div id={optionsId} role="listbox" aria-label="Mention a channel member">
                    {users.map((user, i) => (
                        <button
                            type="button"
                            role="option"
                            tabIndex={-1}
                            aria-selected={user === active}
                            id={`${id}-${user.id}`}
                            className={`tgw-mention-option ${user === active ? 'active' : ''}`}
                            key={user.id}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseEnter={() => setIndex(i)}
                            onClick={() => choose(user)}
                        >
                            <Avatar userId={user.id} profile={user} name={displayName(user)} size={30} previewProfile={false}/>
                            <span className="tgw-mention-name">{displayName(user)}<small>@{user.username}</small></span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );

    return {picker, updateSelection, dismiss, onBlur, onKeyDown, controls: token ? (active ? optionsId : id) : undefined, active: activeId};
}
