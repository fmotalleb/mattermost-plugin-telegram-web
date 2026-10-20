// Modal dialogs: settings, new chat/group/channel, member pickers, channel editing, confirms.

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {api} from '../mm/api';
import {useChannelPosts} from '../mm/posts';
import {ACCENTS, THEME_LABELS, updateSettings, WALLPAPER_LABELS} from '../mm/settings';
import type {AccentName, ThemeName, WallpaperName} from '../mm/settings';
import {getAllChats, getContacts, getCurrentTeamId, getMyId, searchContactCandidates} from '../mm/selectors';
import {useSelector} from '../mm/store';
import type {MMPost, MMUser} from '../mm/types';
import {displayName, fileKindOf, toPlainPreview} from '../mm/utils';
import {useTg} from './context';
import {filesOfPost} from './MessageList';
import {overlayRoot} from './portal';
import {Avatar, IconBack, IconClose, IconForward} from './primitives';

export function ModalShell({title, children, footer, width = 460, onClose}: {title: string; children: React.ReactNode; footer?: React.ReactNode; width?: number; onClose: () => void}) {
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
            <div className="tgw-modal" style={{width}} role="dialog" aria-label={title}>
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
    const filtered = useMemo(() => {
        const excluded = new Set(exclude || []);
        const list = contacts.filter((user) => !excluded.has(user.id));
        if (!term.trim()) {
            return list.slice(0, 120);
        }
        const lower = term.toLowerCase();
        return list.filter((user) => displayName(user).toLowerCase().includes(lower) || (user.username || '').includes(lower));
    }, [contacts, term, exclude]);

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
                {!filtered.length && <div className="tgw-empty-list"><div className="tgw-empty-title">Nobody found</div></div>}
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
                        <span className="tgw-picker-body"><span className="tgw-picker-name">{chat.title}</span></span>
                    </button>
                ))}
                {!choices.length && <div className="tgw-picker-empty">No chats found</div>}
            </div>
        </ModalShell>
    );
}

export function Modals() {
    const {ui} = useTg();
    switch (ui.modal) {
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

export function ImageViewer() {
    const {ui, actions, channel} = useTg();
    const target = ui.imageViewer;
    const {posts} = useChannelPosts(channel?.id);

    // Every image attachment of the open chat, in message order, so the arrows can walk through
    // them. The clicked post is appended as well in case it is not part of the cached page.
    const images = useMemo(() => {
        const list: Array<{post: MMPost; fileId: string}> = [];
        const seen = new Set<string>();
        const push = (post?: MMPost | null) => {
            if (!post) {
                return;
            }
            filesOfPost(post).forEach((file) => {
                if (fileKindOf(file.mime_type || file.name) !== 'image' || seen.has(file.id)) {
                    return;
                }
                seen.add(file.id);
                list.push({post, fileId: file.id});
            });
        };
        posts.forEach(push);
        push(target && target.post);
        return list;
    }, [posts, target]);

    // Position is re-derived whenever the viewer is pointed at a different attachment; cache
    // updates only re-render and must not reset it.
    const [index, setIndex] = useState(0);
    const lastTarget = useRef('');
    const targetKey = target ? `${target.post.id}:${target.fileId || ''}` : '';
    if (target && targetKey !== lastTarget.current) {
        lastTarget.current = targetKey;
        const found = images.findIndex((entry) => entry.post.id === target.post.id && (!target.fileId || entry.fileId === target.fileId));
        setIndex(found >= 0 ? found : 0);
    }

    const close = useCallback(() => actions.setUI({imageViewer: null}), [actions]);
    const move = useCallback((step: number) => {
        setIndex((current) => (images.length ? (current + step + images.length) % images.length : 0));
    }, [images.length]);

    useEffect(() => {
        if (!target) {
            return undefined;
        }
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                move(-1);
            } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                move(1);
            } else if (event.key === 'Escape') {
                close();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [target, move, close]);

    if (!target || !images.length) {
        return null;
    }
    const position = Math.min(index, images.length - 1);
    const current = images[position];
    const showNav = images.length > 1;
    return createPortal(
        <div className="tgw-image-viewer" onMouseDown={(event) => (event.target === event.currentTarget ? close() : undefined)}>
            <button type="button" className="tgw-image-viewer-close" onClick={close} title="Close">
                <IconClose size={24}/>
            </button>
            {showNav && (
                <button type="button" className="tgw-image-viewer-nav tgw-image-viewer-prev" onClick={() => move(-1)} title="Previous attachment">
                    <IconBack size={24}/>
                </button>
            )}
            {showNav && (
                <button type="button" className="tgw-image-viewer-nav tgw-image-viewer-next" onClick={() => move(1)} title="Next attachment">
                    <IconForward size={24}/>
                </button>
            )}
            <div className="tgw-image-viewer-body">
                <img src={api.fileURL(current.fileId)} alt=""/>
                <div className="tgw-image-viewer-caption">{toPlainPreview(current.post.message, 300)}</div>
                {showNav && <div className="tgw-image-viewer-count">{position + 1} / {images.length}</div>}
            </div>
        </div>,
        overlayRoot(),
    );
}
