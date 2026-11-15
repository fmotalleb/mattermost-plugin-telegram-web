import React, {useEffect, useMemo, useState} from 'react';
import {api} from '../mm/api';
import type {MMCommand} from '../mm/types';

// Commands are registered per team, including when the active channel is a DM.
export function useCommandAutocomplete(message: string, teamId: string, channelId: string, enabled: boolean, insert: (value: string) => void) {
    const [commands, setCommands] = useState<MMCommand[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const [retry, setRetry] = useState(0);
    const [index, setIndex] = useState(0);
    const [dismissed, setDismissed] = useState<string | null>(null);
    const id = useMemo(() => `tgw-commands-${Math.random().toString(36).slice(2)}`, []);
    const query = enabled && /^\/[\w-]*$/.test(message) ? message.slice(1).toLowerCase() : null;
    const open = query !== null && dismissed !== message && !!teamId;
    useEffect(() => {
        setDismissed(null);
    }, [message, channelId, teamId]);
    useEffect(() => {
        let cancelled = false;
        setCommands([]);
        setError(false);
        setLoading(!!teamId && enabled);
        if (teamId && enabled) {
            api.getAutocompleteCommands(teamId).then((result) => {
                if (!cancelled) setCommands(Array.isArray(result) ? result.filter((command) => !!command.trigger) : []);
            }).catch(() => { if (!cancelled) setError(true); })
                .finally(() => { if (!cancelled) setLoading(false); });
        }
        return () => { cancelled = true; };
    }, [teamId, channelId, enabled, retry]);
    const matches = commands.filter((command) => command.trigger.toLowerCase().startsWith(query || ''));
    useEffect(() => { setIndex(0); }, [message, commands]);
    useEffect(() => {
        if (open) document.getElementById(`${id}-${index}`)?.scrollIntoView?.({block: 'nearest'});
    }, [open, index]);
    const choose = (command: MMCommand) => {
        insert(`/${command.trigger} `);
        setDismissed(message);
    };
    const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!open || event.nativeEvent.isComposing) return false;
        if (event.key === 'Escape') {
            event.preventDefault(); setDismissed(message); return true;
        }
        if (matches.length && ['ArrowDown', 'ArrowUp', 'Tab', 'Enter'].includes(event.key) && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            if (event.key === 'ArrowDown') setIndex((index + 1) % matches.length);
            else if (event.key === 'ArrowUp') setIndex((index + matches.length - 1) % matches.length);
            else choose(matches[index] || matches[0]);
            return true;
        }
        // Do not swallow submission while discovery is loading or unavailable.
        return false;
    };
    const picker = open && <div className="tgw-command-picker" id={id} role="listbox" aria-label="Bot and slash commands">
        {loading ? <div className="tgw-command-message">Loading commands…</div> : error ? <button type="button" className="tgw-command-message" onMouseDown={(event) => event.preventDefault()} onClick={() => setRetry(retry + 1)}>Could not load commands · Retry</button> : matches.length ? matches.map((command, i) => <button
            type="button" role="option" aria-selected={i === index} id={`${id}-${i}`} key={command.trigger}
            className={`tgw-command-option ${i === index ? 'active' : ''}`}
            onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setIndex(i)} onClick={() => choose(command)}>
            <span>/{command.trigger} <small>{command.auto_complete_hint}</small></span>
            {command.auto_complete_desc && <small>{command.auto_complete_desc}</small>}
        </button>) : <div className="tgw-command-message">No matching commands</div>}
    </div>;
    return {picker, onKeyDown, controls: open ? id : undefined, active: open && matches[index] ? `${id}-${index}` : undefined};
}
