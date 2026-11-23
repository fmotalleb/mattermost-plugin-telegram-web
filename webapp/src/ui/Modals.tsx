// Modal dialogs: settings, new chat/group/channel, member pickers, channel editing, confirms.

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {canSaveFileAs, saveFileAs} from '../mm/file-download';
import {filePreviewKind} from '../mm/file-preview';
import {api} from '../mm/api';
import {useScheduledPosts} from '../mm/scheduled';
import {ACCENTS, THEME_LABELS, updateSettings, WALLPAPER_LABELS} from '../mm/settings';
import type {AccentName, ThemeName, WallpaperName} from '../mm/settings';
import {getAllChats, getContacts, getCurrentTeamId, getMyId, searchContactCandidates} from '../mm/selectors';
import {useSelector} from '../mm/store';
import type {MMChannelNotificationOverrides, MMFileInfo, MMPost, MMScheduledPost, MMUser} from '../mm/types';
import {displayName} from '../mm/utils';
import {useTg} from './context';
import {PDFPreview} from './PDFPreview';
import {overlayRoot} from './portal';
import {Avatar, IconClose, IconDownload} from './primitives';

export function ModalShell({title, children, footer, width = 460, onClose, manageFocus = false}: {title: string; children: React.ReactNode; footer?: React.ReactNode; width?: number; onClose: () => void; manageFocus?: boolean}) {
    const dialog = useRef<HTMLDivElement>(null);
    const latestClose = useRef(onClose);
    latestClose.current = onClose;
    React.useLayoutEffect(() => {
        if (!manageFocus) return;
        const previous = document.activeElement as HTMLElement;
        const controls = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input, textarea, [tabindex="0"]') || []);
        controls()[0]?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault(); event.stopImmediatePropagation(); latestClose.current();
            } else if (event.key === 'Tab') {
                const items = controls();
                const index = items.indexOf(document.activeElement as HTMLElement);
                event.preventDefault(); event.stopImmediatePropagation();
                items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
            }
        };
        const onFocus = (event: FocusEvent) => {
            if (!dialog.current?.contains(event.target as Node)) controls()[0]?.focus();
        };
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('focusin', onFocus);
        return () => {
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('focusin', onFocus);
            if (previous?.isConnected) previous.focus({preventScroll: true});
        };
    }, [manageFocus]);
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    return createPortal(
        <div className="tgw-modal-backdrop" onMouseDown={(event) => (event.target === event.currentTarget ? onClose() : undefined)}>
            <div ref={dialog} className="tgw-modal" style={{width}} role="dialog" aria-modal="true" aria-label={title}>
                <header className="tgw-modal-header">
                    <span>{title}</span>
                    <button type="button" className="tgw-icon-button" onClick={onClose} title="Close">
                        <IconClose size={20}/>
                    </button>
                </header>
                <div className="tgw-modal-body">{children}</div>
                {footer && <footer className="tgw-modal-footer">{footer}</footer>}
            </div>
        </div>,
        overlayRoot(),
    );
}

function MemberPicker({selected, onChange, exclude, placeholder}: {selected: string[]; onChange: (ids: string[]) => void; exclude?: string[]; placeholder?: string}) {
    const [term, setTerm] = useState('');
    const contacts = useSelector(getContacts);
    const matches = useMemo(() => {
        const excluded = new Set(exclude || []);
        const list = contacts.filter((user) => !excluded.has(user.id));
        if (!term.trim()) {
            return list;
        }
        const lower = term.toLowerCase();
        return list.filter((user) => displayName(user).toLowerCase().includes(lower) || (user.username || '').toLowerCase().includes(lower));
    }, [contacts, term, exclude]);
    const filtered = matches.slice(0, 120);
    const matchingIds = matches.map((user) => user.id);
    const allMatchingSelected = matchingIds.length > 0 && matchingIds.every((id) => selected.includes(id));

    const toggle = (userId: string) => {
        onChange(selected.includes(userId) ? selected.filter((id) => id !== userId) : [...selected, userId]);
    };

    return (
        <div className="tgw-picker">
            <input
                autoFocus
                className="tgw-input"
                value={term}
                placeholder={placeholder || 'Search people'}
                onChange={(event) => setTerm(event.target.value)}
                spellCheck={false}
            />
            {selected.length > 0 && (
                <div className="tgw-chips">
                    {selected.map((id) => {
                        const user = contacts.find((entry) => entry.id === id);
                        return (
                            <button type="button" key={id} className="tgw-chip" onClick={() => toggle(id)}>
                                {user ? displayName(user) : id} <span>×</span>
                            </button>
                        );
                    })}
                </div>
            )}
            <div className="tgw-picker-bulk-actions">
                <button type="button" className="tgw-picker-bulk-action" disabled={!matchingIds.length || allMatchingSelected} onClick={() => onChange(Array.from(new Set([...selected, ...matchingIds])))}>Select all{matches.length > 120 ? ` (${matches.length})` : ''}</button>
                <button type="button" className="tgw-picker-bulk-action" disabled={!matchingIds.some((id) => selected.includes(id))} onClick={() => onChange(selected.filter((id) => !matchingIds.includes(id)))}>Deselect all</button>
            </div>
            <div className="tgw-picker-list">
                {filtered.map((user) => (
                    <button
                        type="button"
                        key={user.id}
                        className={`tgw-picker-row ${selected.includes(user.id) ? 'tgw-picker-row-selected' : ''}`}
                        onClick={() => toggle(user.id)}
                    >
                        <Avatar userId={user.id} name={displayName(user)} size={40}/>
                        <span className="tgw-picker-body">
                            <span className="tgw-picker-name">{displayName(user)}</span>
                            <span className="tgw-picker-username">@{user.username}</span>
                        </span>
                        <span className="tgw-picker-check">{selected.includes(user.id) ? '✓' : ''}</span>
                    </button>
                ))}
                {!matches.length && <div className="tgw-empty-list"><div className="tgw-empty-title">Nobody found</div></div>}
            </div>
        </div>
    );
}

export function SettingsModal() {
    const {actions, settings} = useTg();
    return (
        <ModalShell title="Settings" onClose={actions.closeModal} width={480}>
            <div className="tgw-settings">
                <div className="tgw-settings-section">
                    <div className="tgw-settings-label">Appearance</div>
                    <div className="tgw-field">
                        <span>Theme</span>
                        <div className="tgw-segmented">
                            {(Object.keys(THEME_LABELS) as ThemeName[]).map((theme) => (
                                <button
                                    type="button"
                                    key={theme}
                                    className={settings.theme === theme ? 'active' : ''}
                                    onClick={() => updateSettings({theme})}
                                >
                                    {THEME_LABELS[theme]}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="tgw-field">
                        <span>Accent color</span>
                        <div className="tgw-accents">
                            {(Object.keys(ACCENTS) as AccentName[]).map((accent) => (
                                <button
                                    type="button"
                                    key={accent}
                                    title={ACCENTS[accent].label}
                                    className={settings.accent === accent ? 'active' : ''}
                                    style={{background: ACCENTS[accent].color}}
                                    onClick={() => updateSettings({accent})}
                                />
                            ))}
                        </div>
                    </div>
                    <div className="tgw-field">
                        <span>Chat wallpaper</span>
                        <div className="tgw-wallpaper-opts">
                            {(Object.keys(WALLPAPER_LABELS) as WallpaperName[]).map((wallpaper) => (
                                <button
                                    type="button"
                                    key={wallpaper}
                                    title={WALLPAPER_LABELS[wallpaper]}
                                    aria-label={WALLPAPER_LABELS[wallpaper]}
                                    className={`tgw-wallpaper-opt tgw-wallpaper-${wallpaper}${settings.wallpaper === wallpaper ? ' active' : ''}`}
                                    onClick={() => updateSettings({wallpaper})}
                                />
                            ))}
                        </div>
                    </div>
                    <label className="tgw-field tgw-field-check">
                        <input type="checkbox" checked={settings.compactMode} onChange={(event) => updateSettings({compactMode: event.target.checked})}/>
                        <span>Compact message list</span>
                    </label>
                    <label className="tgw-field tgw-field-check">
                        <input type="checkbox" checked={settings.glassyMode} onChange={(event) => updateSettings({glassyMode: event.target.checked})}/>
                        <span>Glassy translucent panels</span>
                    </label>
                    <label className="tgw-field tgw-field-check">
                        <input type="checkbox" checked={settings.animations} onChange={(event) => updateSettings({animations: event.target.checked})}/>
                        <span>Animations</span>
                    </label>
                </div>

                <div className="tgw-settings-section">
                    <div className="tgw-settings-label">Chats</div>
                    <label className="tgw-field tgw-field-check">
                        <input type="checkbox" checked={settings.showPreviews} onChange={(event) => updateSettings({showPreviews: event.target.checked})}/>
                        <span>Show message previews in the chat list</span>
                    </label>
                    <label className="tgw-field tgw-field-check">
                        <input type="checkbox" checked={settings.quietUnreadCounts} onChange={(event) => updateSettings({quietUnreadCounts: event.target.checked})}/>
                        <span>Count only direct messages and mentions; show a dot for other unread chats</span>
                    </label>
                    <label className="tgw-field tgw-field-check">
                        <input type="checkbox" checked={settings.includeMutedInUnread} onChange={(event) => updateSettings({includeMutedInUnread: event.target.checked})}/>
                        <span title="Also includes unmuted channels without mentions of you">Include muted chats in unread messages</span>
                    </label>
                    <label className="tgw-field tgw-field-check">
                        <input type="checkbox" checked={settings.pinFavoritesInAll} onChange={(event) => updateSettings({pinFavoritesInAll: event.target.checked})}/>
                        <span>Pin favorites to the top of All messages</span>
                    </label>
                    <label className="tgw-field tgw-field-check">
                        <input type="checkbox" checked={settings.pinUnreadInAll} onChange={(event) => updateSettings({pinUnreadInAll: event.target.checked})}/>
                        <span>Pin unread chats to the top of All messages</span>
                    </label>
                    <label className="tgw-field tgw-field-check">
                        <input type="checkbox" checked={settings.folderTabs} onChange={(event) => updateSettings({folderTabs: event.target.checked})}/>
                        <span>Show folders (Mattermost categories)</span>
                    </label>
                    <label className="tgw-field tgw-field-check">
                        <input type="checkbox" checked={settings.jalali} onChange={(event) => updateSettings({jalali: event.target.checked})}/>
                        <span>Jalali (Solar Hijri) dates</span>
                    </label>
                </div>

                <div className="tgw-settings-section">
                    <div className="tgw-settings-label">Plugin</div>
                    <div className="tgw-field">
                        <span>Telegram Web UI</span>
                        <button type="button" className="tgw-button tgw-button-secondary" onClick={actions.disableUI}>Switch back to Mattermost UI</button>
                    </div>
                    <div className="tgw-settings-hint">
                        Settings are stored as a Mattermost user preference and mirrored in this browser's local storage, so they follow your account and paint instantly on reload.
                    </div>
                </div>
            </div>
        </ModalShell>
    );
}

export function NewContactModal({payload}: {payload?: {userId?: string}}) {
    const {actions, me} = useTg();
    const [term, setTerm] = useState('');
    const contacts = useSelector((state) => searchContactCandidates(state, '', 200));
    const [userId] = useState(payload?.userId || '');

    useEffect(() => {
        if (!userId || !me) {
            return;
        }
        api.createDirectChannel([me.id, userId])
            .then((channel) => {
                actions.closeModal();
                actions.openChat(channel.id);
            })
            .catch(() => actions.toast('Could not open the conversation', 'error'));
    }, [userId, me]);

    const openWith = (target: string) => {
        if (!me) {
            return;
        }
        api.createDirectChannel([me.id, target])
            .then((channel) => {
                actions.closeModal();
                actions.openChat(channel.id);
            })
            .catch(() => actions.toast('Could not open the conversation', 'error'));
    };

    const filtered = contacts.filter((user) => !term.trim() || displayName(user).toLowerCase().includes(term.toLowerCase()) || (user.username || '').includes(term.toLowerCase()));

    return (
        <ModalShell title="New message" onClose={actions.closeModal}>
            <input
                autoFocus
                className="tgw-input"
                value={term}
                placeholder="Search people"
                onChange={(event) => setTerm(event.target.value)}
            />
            <div className="tgw-picker-list tgw-picker-list-tall">
                {filtered.slice(0, 200).map((user: MMUser) => (
                    <button type="button" key={user.id} className="tgw-picker-row" onClick={() => openWith(user.id)}>
                        <Avatar userId={user.id} name={displayName(user)} size={40}/>
                        <span className="tgw-picker-body">
                            <span className="tgw-picker-name">{displayName(user)}</span>
                            <span className="tgw-picker-username">@{user.username}</span>
                        </span>
                    </button>
                ))}
            </div>
        </ModalShell>
    );
}

export function NewGroupModal() {
    const {actions, me} = useTg();
    const [selected, setSelected] = useState<string[]>([]);
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);

    const create = async () => {
        if (!me || !selected.length) {
            return;
        }
        setBusy(true);
        try {
            let channel;
            if (selected.length === 1) {
                channel = await api.createDirectChannel([me.id, selected[0]]);
            } else {
                channel = await api.createGroupChannel([me.id, ...selected]);
            }
            if (name && channel) {
                await api.updateChannel(channel.id, {display_name: name}).catch(() => undefined);
            }
            actions.closeModal();
            if (channel) {
                actions.openChat(channel.id);
            }
        } catch (error: any) {
            actions.toast(error?.message || 'Could not create the group', 'error');
        }
        setBusy(false);
    };

    return (
        <ModalShell
            title="New group"
            onClose={actions.closeModal}
            footer={
                <>
                    <button type="button" className="tgw-button" disabled={!selected.length || busy} onClick={create}>
                        {selected.length === 1 ? 'Create chat' : 'Create group'}
                    </button>
                </>
            }
        >
            <input className="tgw-input" value={name} placeholder="Group name (optional)" onChange={(event) => setName(event.target.value)}/>
            <MemberPicker selected={selected} onChange={setSelected} exclude={me ? [me.id] : []}/>
        </ModalShell>
    );
}

export function NewChannelModal() {
    const {actions, me} = useTg();
    const teamId = useSelector(getCurrentTeamId);
    const [name, setName] = useState('');
    const [displayNameValue, setDisplayNameValue] = useState('');
    const [purpose, setPurpose] = useState('');
    const [isPrivate, setIsPrivate] = useState(false);
    const [selected, setSelected] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);

    const create = async () => {
        if (!name.trim()) {
            actions.toast('A channel name is required', 'error');
            return;
        }
        setBusy(true);
        try {
            const channel = await api.createChannel(teamId, {
                name: name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-'),
                display_name: displayNameValue.trim() || name.trim(),
                purpose,
                type: isPrivate ? 'P' : 'O',
            });
            for (const userId of selected) {
                // eslint-disable-next-line no-await-in-loop
                await api.addChannelMember(channel.id, userId).catch(() => undefined);
            }
            actions.closeModal();
            actions.openChat(channel.id);
        } catch (error: any) {
            actions.toast(error?.message || 'Could not create the channel', 'error');
        }
        setBusy(false);
    };

    return (
        <ModalShell
            title="New channel"
            onClose={actions.closeModal}
            footer={<button type="button" className="tgw-button" disabled={busy || !name.trim()} onClick={create}>Create channel</button>}
        >
            <input className="tgw-input" value={displayNameValue} placeholder="Channel display name" onChange={(event) => setDisplayNameValue(event.target.value)}/>
            <input className="tgw-input" value={name} placeholder="channel-name (lowercase, no spaces)" onChange={(event) => setName(event.target.value)}/>
            <textarea className="tgw-input" rows={2} value={purpose} placeholder="Purpose (optional)" onChange={(event) => setPurpose(event.target.value)}/>
            <div className="tgw-segmented tgw-segmented-full">
                <button type="button" className={!isPrivate ? 'active' : ''} onClick={() => setIsPrivate(false)}>Public</button>
                <button type="button" className={isPrivate ? 'active' : ''} onClick={() => setIsPrivate(true)}>Private</button>
            </div>
            <MemberPicker selected={selected} onChange={setSelected} exclude={me ? [me.id] : []} placeholder="Add members (optional)"/>
        </ModalShell>
    );
}

export function AddMembersModal({payload}: {payload?: {channelId: string}}) {
    const {actions, me} = useTg();
    const [selected, setSelected] = useState<string[]>([]);
    const storeMembers = useSelector((state) => Object.keys(state.entities?.channels?.membersInChannel?.[payload?.channelId || ''] || {}));
    const [restMembers, setRestMembers] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!payload?.channelId) {
            return undefined;
        }
        let cancelled = false;
        api.getChannelMembers(payload.channelId, 0, 200)
            .then((members) => {
                if (!cancelled && Array.isArray(members)) {
                    setRestMembers(members.map((member: {user_id?: string}) => member.user_id).filter(Boolean));
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [payload?.channelId]);

    // The store copy is often sparse (only whoever the host webapp loaded), so merge in the REST list.
    const members = Array.from(new Set([...storeMembers, ...restMembers]));

    const add = async () => {
        if (!payload?.channelId || !selected.length) {
            return;
        }
        setBusy(true);
        let added = 0;
        for (const userId of selected) {
            try {
                // eslint-disable-next-line no-await-in-loop
                await api.addChannelMember(payload.channelId, userId);
                added += 1;
            } catch (error) {
                // keep going, report at the end
            }
        }
        setBusy(false);
        actions.closeModal();
        actions.toast(added ? `${added} member${added === 1 ? '' : 's'} added` : 'No member could be added', added ? 'success' : 'error');
    };

    return (
        <ModalShell
            title="Add members"
            onClose={actions.closeModal}
            footer={<button type="button" className="tgw-button" disabled={busy || !selected.length} onClick={add}>Add</button>}
        >
            <MemberPicker selected={selected} onChange={setSelected} exclude={[me?.id || '', ...members]} placeholder="Search people to add"/>
        </ModalShell>
    );
}

export function ChannelInfoModal({payload}: {payload?: {channelId: string}}) {
    const {actions} = useTg();
    const channel = useSelector((state) => state.entities?.channels?.channels?.[payload?.channelId || '']);
    const [displayNameValue, setDisplayNameValue] = useState(channel?.display_name || '');
    const [purpose, setPurpose] = useState(channel?.purpose || '');
    const [header, setHeader] = useState(channel?.header || '');
    const [busy, setBusy] = useState(false);

    const save = async () => {
        if (!payload?.channelId) {
            return;
        }
        setBusy(true);
        try {
            await api.updateChannel(payload.channelId, {display_name: displayNameValue, purpose, header});
            actions.closeModal();
            actions.toast('Group updated', 'success');
        } catch (error: any) {
            actions.toast(error?.message || 'Could not update the group', 'error');
        }
        setBusy(false);
    };

    return (
        <ModalShell
            title="Group details"
            onClose={actions.closeModal}
            footer={<button type="button" className="tgw-button" disabled={busy} onClick={save}>Save</button>}
        >
            <input className="tgw-input" value={displayNameValue} placeholder="Display name" onChange={(event) => setDisplayNameValue(event.target.value)}/>
            <textarea className="tgw-input" rows={2} value={purpose} placeholder="Purpose" onChange={(event) => setPurpose(event.target.value)}/>
            <textarea className="tgw-input" rows={2} value={header} placeholder="Header" onChange={(event) => setHeader(event.target.value)}/>
        </ModalShell>
    );
}

export function ConfirmModal() {
    const {ui, actions} = useTg();
    const dialogRef = useRef(ui.confirm);
    dialogRef.current = ui.confirm;
    if (!ui.confirm) {
        return null;
    }
    return (
        <ModalShell
            title={ui.confirm.title}
            width={420}
            onClose={() => actions.setUI({confirm: null})}
            footer={
                <>
                    <button type="button" className="tgw-button tgw-button-secondary" onClick={() => actions.setUI({confirm: null})}>Cancel</button>
                    <button
                        type="button"
                        className={`tgw-button ${ui.confirm.danger ? 'tgw-button-danger' : ''}`}
                        onClick={() => {
                            const dialog = ui.confirm!;
                            actions.setUI({confirm: null});
                            dialog.onConfirm();
                        }}
                    >
                        {ui.confirm.confirmLabel || 'Confirm'}
                    </button>
                </>
            }
        >
            <div className="tgw-confirm-body">{ui.confirm.body || 'This action cannot be undone.'}</div>
        </ModalShell>
    );
}

function ForwardModal({post}: {post: MMPost}) {
    const {actions} = useTg();
    const chats = useSelector(getAllChats);
    const [term, setTerm] = useState('');
    const [busy, setBusy] = useState(false);
    const choices = chats.filter((chat) => chat.title.toLowerCase().includes(term.trim().toLowerCase()));
    const forward = async (channelId: string) => {
        if (busy) {
            return;
        }
        setBusy(true);
        try {
            await api.forwardPost(post.id, channelId);
            actions.closeModal();
            actions.toast('Message forwarded', 'success');
        } catch (error: any) {
            actions.toast(error?.message || 'Could not forward the message', 'error');
            setBusy(false);
        }
    };
    return (
        <ModalShell title="Forward message" onClose={actions.closeModal}>
            <input autoFocus className="tgw-input" value={term} placeholder="Search chats" onChange={(event) => setTerm(event.target.value)}/>
            <div className="tgw-picker-list tgw-picker-list-tall">
                {choices.map((chat) => (
                    <button type="button" className="tgw-picker-row" key={chat.id} disabled={busy} onClick={() => forward(chat.id)}>
                        <Avatar
                            userId={chat.type === 'D' ? chat.avatarUserId || chat.peerIds[0] : undefined}
                            name={chat.title}
                            colorKey={chat.type === 'D' ? chat.avatarUserId || chat.peerIds[0] || chat.id : chat.id}
                            imageUrl={chat.avatarUrl}
                            savedMessages={chat.title === 'Saved Messages'}
                            previewProfile={false}
                            size={40}
                        />
                        <span className="tgw-picker-body"><span className="tgw-picker-name">{chat.title}</span></span>
                    </button>
                ))}
                {!choices.length && <div className="tgw-picker-empty">No chats found</div>}
            </div>
        </ModalShell>
    );
}

export function UserProfileModal({payload}: {payload: {userId?: string; username?: string}}) {
    const {actions, ui} = useTg();
    const cached = useSelector((state) => payload.userId
        ? state.entities?.users?.profiles?.[payload.userId]
        : Object.values(state.entities?.users?.profiles || {}).find((user) => user.username === payload.username));
    const [loaded, setLoaded] = useState<MMUser | null>(null);
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let cancelled = false;
        setLoaded(null);
        setError(false);
        if (cached) return;
        const request = payload.userId ? api.getUsersByIds([payload.userId]).then((users) => users[0])
            : api.getUserByUsername(payload.username || '');
        request.then((user) => {
            if (!cancelled) { setLoaded(user || null); setError(!user); }
        }).catch(() => { if (!cancelled) setError(true); });
        return () => { cancelled = true; };
    }, [payload.userId, payload.username, cached, attempt]);
    const user = cached || loaded;
    return <ModalShell title="User profile" manageFocus onClose={actions.closeModal} footer={user && (
        <button type="button" className="tgw-button" disabled={!!user.delete_at} title={user.delete_at ? 'This account is deactivated' : undefined}
            onClick={() => { actions.closeModal(); if (ui.quickChatId) actions.setUI({quickChatId: undefined}); actions.openUserChat(user.id); }}>Open direct chat</button>
    )}>
        {user ? <div className="tgw-info-profile">
            <Avatar userId={user.id} profile={user} name={displayName(user)} size={128} previewProfile={false}/>
            <div className="tgw-info-name">{displayName(user)}</div>
            <div className="tgw-info-sub">@{user.username}{user.is_bot || user.bot ? ' · bot' : ''}</div>
            {user.nickname && <div className="tgw-info-text">{user.nickname}</div>}
            {user.position && <div className="tgw-info-text">{user.position}</div>}
            {user.email && <div className="tgw-info-text">{user.email}</div>}
        </div> : error ? <div className="tgw-picker-empty">Could not load this profile. <button type="button" className="tgw-button" onClick={() => setAttempt(attempt + 1)}>Retry</button></div>
            : <div className="tgw-picker-empty">Loading profile…</div>}
    </ModalShell>;
}

const channelNotificationFields: Array<{key: keyof MMChannelNotificationOverrides; label: string; options: Array<[string, string]>}> = [
    {key: 'desktop', label: 'Desktop notifications', options: [['default', 'Account default'], ['all', 'All messages'], ['mention', 'Mentions only'], ['none', 'Nothing']]},
    {key: 'push', label: 'Mobile push notifications', options: [['default', 'Account default'], ['all', 'All messages'], ['mention', 'Mentions only'], ['none', 'Nothing']]},
    {key: 'email', label: 'Email notifications', options: [['default', 'Account default'], ['true', 'Enabled'], ['false', 'Disabled']]},
    {key: 'mark_unread', label: 'Unread indicators', options: [['all', 'All messages'], ['mention', 'Mentions only']]},
    {key: 'ignore_channel_mentions', label: 'Channel-wide mentions', options: [['default', 'Account default'], ['off', 'Notify'], ['on', 'Ignore']]},
    {key: 'channel_auto_follow_threads', label: 'Automatically follow threads', options: [['on', 'Enabled'], ['off', 'Disabled']]},
];

export function ChannelNotificationsModal({payload}: {payload: {channelId: string; title?: string}}) {
    const {actions, me} = useTg();
    const [values, setValues] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const inFlight = useRef(false);
    const isAdmin = me?.roles?.split(/\s+/).includes('system_admin');
    const close = () => { if (!inFlight.current) actions.closeModal(); };
    const patch = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '')) as MMChannelNotificationOverrides;
    if (!isAdmin) return null;
    const apply = async () => {
        if (inFlight.current || !Object.keys(patch).length) return;
        inFlight.current = true;
        setSaving(true);
        setError('');
        try {
            const result = await api.overrideChannelNotificationsForEveryone(payload.channelId, patch);
            if (result.failed) {
                setError(`Updated ${result.updated} members; ${result.failed} could not be updated. You can retry these settings.`);
            } else {
                actions.toast(`Notification settings updated for ${result.updated} members`, 'success');
                actions.closeModal();
            }
        } catch (err: any) {
            setError(err.message || 'Could not update notification settings');
        } finally {
            inFlight.current = false;
            setSaving(false);
        }
    };
    return <ModalShell title="Override channel notifications" onClose={close} width={540} footer={<>
        <button type="button" className="tgw-button tgw-button-secondary" disabled={saving} onClick={close}>Cancel</button>
        <button type="button" className="tgw-button" disabled={saving || !Object.keys(patch).length} onClick={apply}>{saving ? 'Applying…' : 'Apply to everyone'}</button>
    </>}>
        <div className="tgw-settings-section">
            <p>Selected settings will replace the notification settings for every current member of {payload.title || 'this channel'}. Members can change them again afterward; future members are not affected.</p>
            {channelNotificationFields.map((field) => <label className="tgw-field" key={field.key}>
                <span>{field.label}</span>
                <select className="tgw-input" style={{width: '60%', minWidth: 0}} aria-label={field.label} disabled={saving} value={values[field.key] || ''}
                    onChange={(event) => setValues({...values, [field.key]: event.target.value})}>
                    <option value="">Keep unchanged</option>
                    {field.options.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
            </label>)}
            {error && <p role="alert">{error}</p>}
        </div>
    </ModalShell>;
}

export function ScheduledMessagesModal({channelId}: {channelId: string}) {
    const {actions, timeFormat, settings, ui} = useTg();
    const formatter = new Intl.DateTimeFormat(timeFormat.locale, {calendar: settings.jalali ? 'persian' : 'gregory', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: !timeFormat.military});
    const sendTime = (timestamp: number) => {
        const date = new Date(timestamp);
        return Number.isNaN(date.getTime()) ? 'Unknown send time' : formatter.format(date);
    };
    const {posts, loading, loaded, error, refresh} = useScheduledPosts(channelId);
    const [pending, setPending] = useState('');
    const [actionError, setActionError] = useState('');
    const inFlight = useRef(false);
    const close = () => { if (!inFlight.current) actions.closeModal(); };
    const change = async (post: MMScheduledPost, edit: boolean) => {
        if (inFlight.current) return;
        inFlight.current = true;
        setPending(post.id);
        setActionError('');
        try {
            // Resolve everything before cancelling, so a failed attachment/thread fetch keeps the schedule intact.
            const files = edit ? await Promise.all((post.file_ids || []).map((id) => api.request<MMFileInfo>(`/files/${encodeURIComponent(id)}/info`))) : [];
            const replyTo = edit && post.root_id ? await api.getPost(post.root_id) : null;
            const removed = await api.deleteScheduledPost(post.id);
            if (edit) {
                actions.closeModal();
                if (ui.quickChatId || ui.selectedChannelId !== channelId) actions.openChat(channelId);
                actions.setUI({quickChatId: undefined, editing: null, replyTo, threadRootId: null,
                    scheduledDraft: {post: removed, files, quick: false}});
            } else {
                actions.toast('Scheduled message removed', 'success');
            }
        } catch (error: any) {
            setActionError(error?.message || 'Could not change this scheduled message');
        } finally {
            inFlight.current = false;
            setPending('');
        }
    };
    return <ModalShell title="Scheduled messages" manageFocus onClose={close} width={560}>
        <div className="tgw-scheduled-content">
            <div className="tgw-scheduled-toolbar">
                <span>Your messages in this chat · {Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
                <button type="button" className="tgw-button tgw-button-secondary" disabled={loading} onClick={() => void refresh()}>Refresh</button>
            </div>
            {loading && !loaded && <div className="tgw-picker-empty" role="status">Loading scheduled messages…</div>}
            {error && <div role="alert">{error} <button type="button" className="tgw-button tgw-button-secondary" disabled={loading} onClick={() => void refresh()}>Retry</button></div>}
            {!loading && !error && loaded && !posts.length && <div className="tgw-picker-empty">No scheduled messages in this chat</div>}
            {actionError && <div role="alert">{actionError}</div>}
            <div className="tgw-scheduled-list">
                {posts.map((post) => <article className="tgw-scheduled-message" key={post.id}>
                    <div className="tgw-scheduled-meta"><time>{sendTime(post.scheduled_at)}</time>
                        <span className={post.error_code ? 'tgw-scheduled-failed' : ''}>{post.error_code ? 'Failed to send' : post.scheduled_at <= Date.now() ? 'Waiting to send' : 'Scheduled'}</span></div>
                    {post.priority?.priority === 'urgent' && <div className="tgw-msg-priority">Urgent</div>}
                    <div className="tgw-scheduled-message-text">{post.message || (post.props?.voice ? 'Voice message' : 'Attachment')}</div>
                    {post.file_ids?.length > 0 && <div className="tgw-scheduled-detail">{post.file_ids.length} attachment{post.file_ids.length === 1 ? '' : 's'}</div>}
                    {post.root_id && <div className="tgw-scheduled-detail">Thread reply</div>}
                    <div className="tgw-scheduled-actions">
                        <button type="button" className="tgw-button tgw-button-secondary" disabled={!!pending} title="Remove from schedule and edit text and send time" onClick={() => void change(post, true)}>Edit</button>
                        <button type="button" className="tgw-button tgw-button-secondary" disabled={!!pending} onClick={() => void change(post, false)}>Remove</button>
                        {pending === post.id && <span role="status">Updating…</span>}
                    </div>
                    {post.error_code && <div className="tgw-scheduled-detail">{post.error_code === 'delivery_failed' ? 'The server could not deliver this message.' : post.error_code}</div>}
                </article>)}
            </div>
        </div>
    </ModalShell>;
}

export function FilePreviewModal({file}: {file: MMFileInfo}) {
    const {actions} = useTg();
    const kind = filePreviewKind(file);
    const [text, setText] = useState<string | undefined>();
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (kind === 'pdf') return;
        const controller = new AbortController();
        setText(undefined); setError('');
        const load = async () => {
            if (kind !== 'text') throw new Error('Preview is unavailable for this file.');
            if (file.size > 2 * 1024 * 1024) throw new Error('This file is too large to preview. Please download it instead.');
            const blob = await api.getFilePreview(file.id, 2 * 1024 * 1024, controller.signal);
            const content = await blob.text();
            if (!controller.signal.aborted) setText(content);
        };
        load().catch((err) => { if (!controller.signal.aborted) setError(err.message || 'Could not load this file.'); });
        return () => controller.abort();
    }, [file.id, file.size, kind, attempt]);
    return <ModalShell title={file.name} width={1000} manageFocus onClose={actions.closeModal} footer={<>
        {canSaveFileAs() && <button type="button" className="tgw-button" onClick={() => saveFileAs(file, actions.toast)}>Save as…</button>}
        <a className="tgw-button" href={api.fileDownloadURL(file.id)} download={file.name}><IconDownload size={18}/>Download</a>
    </>}>
        <div className="tgw-file-preview">
            {kind === 'pdf' ? <PDFPreview file={file}/>
                : error ? <div role="alert">{error} <button type="button" className="tgw-button" onClick={() => setAttempt(attempt + 1)}>Retry</button></div>
                    : text !== undefined ? <pre className="tgw-file-preview-text" tabIndex={0}>{text || 'This file is empty.'}</pre>
                        : <div role="status">Loading file…</div>}
        </div>
    </ModalShell>;
}

export function Modals() {
    const {ui} = useTg();
    switch (ui.modal) {
    case 'filePreview':
        return ui.modalPayload?.file ? <FilePreviewModal key={ui.modalPayload.file.id} file={ui.modalPayload.file}/> : null;
    case 'scheduledMessages':
        return ui.modalPayload?.channelId ? <ScheduledMessagesModal key={ui.modalPayload.channelId} channelId={ui.modalPayload.channelId}/> : null;
    case 'channelNotifications':
        return <ChannelNotificationsModal key={ui.modalPayload?.channelId} payload={ui.modalPayload}/>;
    case 'userProfile':
        return <UserProfileModal key={ui.modalPayload?.userId || ui.modalPayload?.username} payload={ui.modalPayload || {}}/>;
    case 'settings':
        return <SettingsModal/>;
    case 'newContact':
        return <NewContactModal payload={ui.modalPayload}/>;
    case 'newGroup':
        return <NewGroupModal/>;
    case 'newChannel':
        return <NewChannelModal/>;
    case 'addMembers':
        return <AddMembersModal payload={ui.modalPayload}/>;
    case 'channelInfo':
        return <ChannelInfoModal payload={ui.modalPayload}/>;
    case 'forward':
        return ui.modalPayload?.post ? <ForwardModal post={ui.modalPayload.post}/> : null;
    default:
        return null;
    }
}
