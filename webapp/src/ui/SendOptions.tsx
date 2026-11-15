import React, {useEffect, useRef, useState} from 'react';
import {IconClock, IconWarning} from './primitives';
import {useScheduledPosts} from '../mm/scheduled';
import {useTg} from './context';

function localDateTime(timestamp: number) {
    const date = new Date(timestamp);
    const part = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

export function SendOptions({urgent, onUrgent, priorityDisabled, disabled, busy, canSend, onSchedule, restoreSchedule}: {
    restoreSchedule?: {id: string; scheduledAt: number};
    urgent: boolean; onUrgent: (value: boolean) => void; priorityDisabled: boolean;
    disabled: boolean; busy: boolean; canSend: boolean; onSchedule: (timestamp: number) => Promise<boolean>;
}) {
    const {channel, actions} = useTg();
    const {posts} = useScheduledPosts(channel?.id);
    const count = posts.length;
    const failedCount = posts.filter((post) => post.error_code).length;
    const countLabel = `${count} scheduled message${count === 1 ? '' : 's'}${failedCount ? `, ${failedCount} failed` : ''}`;
    const [open, setOpen] = useState(false);
    const [when, setWhen] = useState('');
    const [error, setError] = useState('');
    const wrapper = useRef<HTMLDivElement>(null);
    const scheduleButton = useRef<HTMLButtonElement>(null);
    const dateInput = useRef<HTMLInputElement>(null);
    const openQueue = () => { setOpen(false); scheduleButton.current?.focus(); if (channel) actions.openModal('scheduledMessages', {channelId: channel.id}); };
    useEffect(() => {
        if (!restoreSchedule) return;
        setWhen(localDateTime(restoreSchedule.scheduledAt));
        setError('');
        setOpen(true);
    }, [restoreSchedule]);
    useEffect(() => {
        if (disabled) setOpen(false);
    }, [disabled]);
    useEffect(() => {
        if (!open) return;
        dateInput.current?.focus();
        const outside = (event: MouseEvent) => { if (!wrapper.current?.contains(event.target as Node)) setOpen(false); };
        document.addEventListener('mousedown', outside);
        return () => document.removeEventListener('mousedown', outside);
    }, [open]);
    const close = () => { setOpen(false); scheduleButton.current?.focus(); };
    return <div className="tgw-send-options" ref={wrapper}>
        <button type="button" className={`tgw-urgent-toggle ${urgent && !priorityDisabled ? 'active' : ''}`} aria-pressed={urgent && !priorityDisabled}
            title={priorityDisabled ? 'Urgent priority is unavailable for replies and commands' : 'Send as urgent'}
            disabled={disabled || priorityDisabled || busy} onClick={() => onUrgent(!urgent)}><IconWarning size={16}/><span>Urgent</span></button>
        <button type="button" ref={scheduleButton} className="tgw-schedule-toggle"
            title={count ? `Schedule send · ${countLabel} · Right-click to view` : 'Schedule send · Right-click to view scheduled messages'}
            aria-label={count ? `Schedule send, ${countLabel}` : 'Schedule send'} aria-expanded={open}
            onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); openQueue(); }}
            onKeyDown={(event) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openQueue(); } }}
            disabled={disabled || busy} onClick={() => { setWhen(restoreSchedule ? when || localDateTime(restoreSchedule.scheduledAt) : localDateTime(Date.now() + 3600000)); setError(''); setOpen(!open); }}><IconClock size={16}/><span>Schedule</span>{count > 0 && <span className={`tgw-schedule-count ${failedCount ? 'tgw-schedule-count-error' : ''}`} aria-hidden="true">{count > 99 ? '99+' : count}</span>}</button>
        {open && !disabled && <div className="tgw-schedule-panel" role="group" aria-label="Schedule message"
            onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
            <label>Send at<input ref={dateInput} aria-label="Scheduled send time" type="datetime-local" value={when} min={localDateTime(Date.now() + 60000)}
                disabled={busy} onChange={(event) => { setWhen(event.target.value); setError(''); }}/></label>
            <small>Local time ({Intl.DateTimeFormat().resolvedOptions().timeZone})</small>
            {error && <div className="tgw-schedule-error" role="alert">{error}</div>}
            <div className="tgw-schedule-actions">
                <button type="button" disabled={busy} onClick={close}>Cancel</button>
                <button type="button" disabled={busy || !canSend} onClick={async () => {
                    const timestamp = new Date(when).getTime();
                    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) { setError('Choose a time in the future'); return; }
                    if (await onSchedule(timestamp)) { close(); setWhen(''); }
                }}>{busy ? 'Scheduling…' : 'Schedule message'}</button>
            </div>
        </div>}
    </div>;
}
