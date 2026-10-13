// Right hand "Info" panel: chat details, actions and the member list.

import React, {useEffect, useMemo, useState} from 'react';
import {api} from '../mm/api';
import {getChatSummary, getMemberCount, getMyId, getPeersOfDirectChannel} from '../mm/selectors';
import {useSelector} from '../mm/store';
import type {MMChannel, MMUser} from '../mm/types';
import {displayName, memberCountLabel, statusLabel} from '../mm/utils';
import {useTg} from './context';
import {Menu} from './menu';
import type {MenuEntry} from './menu';
import {Avatar, IconBell, IconClose, IconEdit, IconMute, IconSearch, IconStar, IconStarOutline, IconUsers, IconLogout} from './primitives';

export function InfoPanel() {
    const {actions, channel, timeFormat} = useTg();
    const summary = useSelector((state) => (channel ? getChatSummary(state, channel.id) : undefined));
    const myId = useSelector(getMyId);
    const peers = useSelector((state) => (channel && channel.type === 'D' ? getPeersOfDirectChannel(state, channel) : []));
    const storeMembers = useSelector((state) => (channel ? state.entities?.channels?.membersInChannel?.[channel.id] : undefined));
    const profiles = useSelector((state) => state.entities?.users?.profiles);
    const [memberIds, setMemberIds] = useState<string[]>([]);
    const [fetchedProfiles, setFetchedProfiles] = useState<Record<string, MMUser>>({});
    const [memberMenu, setMemberMenu] = useState<{x: number; y: number; items: MenuEntry[]} | null>(null);
    const channelMemberCount = useSelector((state) => (channel ? getMemberCount(state, channel.id) : 0));

    useEffect(() => {
        if (!channel || channel.type === 'D') {
            return undefined;
        }
        let cancelled = false;
        (async () => {
            setMemberIds([]);
            setFetchedProfiles({});
            try {
                // The Redux store only knows about members the host webapp happened to load
                // (often just yourself), so the REST list is the source of truth here.
                const ids: string[] = [];
                for (let page = 0; page < 5; page++) {
                    const members = await api.getChannelMembers(channel.id, page, 200);
                    if (!Array.isArray(members) || !members.length) {
                        break;
                    }
                    ids.push(...members.map((member: {user_id?: string}) => member.user_id).filter(Boolean));
                    if (members.length < 200) {
                        break;
                    }
                }
                if (cancelled || !ids.length) {
                    return;
                }
                setMemberIds(Array.from(new Set(ids)));

                // Profiles in the Redux cache may be missing people, so fetch all of them.
                const map: Record<string, MMUser> = {};
                for (let index = 0; index < ids.length; index += 100) {
                    const users = await api.getUsersByIds(ids.slice(index, index + 100));
                    if (cancelled || !users) {
                        return;
                    }
                    users.forEach((user) => {
                        map[user.id] = user;
                    });
                }
                setFetchedProfiles(map);
            } catch {
                // Fall back to whatever the host app already has in its store (see members memo).
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [channel?.id]);

    const members = useMemo(() => {
        const ids = memberIds.length ? memberIds : Object.keys(storeMembers || {});
        return Array.from(new Set(ids))
            .map((id) => ({id, user: fetchedProfiles[id] || profiles?.[id]}))
            .filter((entry) => !!entry.user && entry.user.delete_at === 0)
            .sort((a, b) => displayName(a.user).localeCompare(displayName(b.user)));
    }, [memberIds, storeMembers, fetchedProfiles, profiles]);

    if (!channel || !summary) {
        return null;
    }

    const isDirect = channel.type === 'D';
    const isChannel = channel.type === 'O' || channel.type === 'P';
    const memberCount = isDirect ? 2 : (channelMemberCount || summary.memberCount);

    const toggleFavorite = () => {
        const webapp = (window as any).WebappUtils;
        if (!webapp?.channels?.favoriteChannel) {
            actions.toast('Favorites are not available', 'error');
            return;
        }
        if (summary.isFavorite) {
            webapp.channels.unfavoriteChannel(channel.id);
        } else {
            webapp.channels.favoriteChannel(channel.id);
        }
    };

    const toggleMute = () => {
        api.updateChannelNotifyProps(channel.id, myId, {
            desktop: summary.muted ? 'default' : 'none',
            mark_unread: summary.muted ? 'all' : 'mention',
        }).catch(() => actions.toast('Could not change notifications', 'error'));
    };

    const openMemberMenu = (event: React.MouseEvent, user: MMUser) => {
        event.preventDefault();
        const items: MenuEntry[] = [
            {key: 'dm', label: 'Send message', onClick: () => actions.openModal('newContact', {userId: user.id})},
        ];
        if (!isDirect) {
            items.push({
                key: 'promote',
                label: 'Remove from group',
                danger: true,
                onClick: () => actions.askConfirm({
                    title: `Remove ${displayName(user)} from ${summary.title}?`,
                    confirmLabel: 'Remove',
                    danger: true,
                    onConfirm: () => api.removeChannelMember(channel.id, user.id)
                        .then(() => actions.toast('Member removed', 'success'))
                        .catch(() => actions.toast('You are not allowed to remove this member', 'error')),
                }),
            });
        }
        setMemberMenu({x: event.clientX, y: event.clientY, items});
    };

    return (
        <aside className="tgw-info-panel">
            <header className="tgw-info-header">
                <span className="tgw-info-title">{isDirect ? 'Contact info' : 'Group info'}</span>
                <button type="button" className="tgw-icon-button" onClick={() => actions.setUI({infoOpen: false})} title="Close">
                    <IconClose size={20}/>
                </button>
            </header>

            <div className="tgw-info-profile">
                <Avatar
                    userId={summary.avatarUserId}
                    name={summary.title}
                    colorKey={isDirect ? summary.peerIds[0] : channel.id}
                    size={110}
                    status={summary.status}
                    showStatus={isDirect}
                />
                <div className="tgw-info-name">{summary.title}</div>
                <div className="tgw-info-sub">
                    {isDirect
                        ? statusLabel(summary.status, 0, timeFormat)
                        : memberCountLabel(memberCount) || 'group'}
                </div>
            </div>

            <div className="tgw-info-actions">
                <button type="button" className={`tgw-info-action ${summary.muted ? 'active' : ''}`} onClick={toggleMute} title={summary.muted ? 'Unmute' : 'Mute'}>
                    {summary.muted ? <IconBell size={22}/> : <IconMute size={22}/>}
                    <span>{summary.muted ? 'Unmute' : 'Mute'}</span>
                </button>
                <button type="button" className={`tgw-info-action ${summary.isFavorite ? 'active' : ''}`} onClick={toggleFavorite} title="Favorite">
                    {summary.isFavorite ? <IconStar size={22}/> : <IconStarOutline size={22}/>}
                    <span>{summary.isFavorite ? 'Favorited' : 'Favorite'}</span>
                </button>
                <button type="button" className="tgw-info-action" onClick={() => actions.setUI({infoOpen: false})} title="Search in chat">
                    <IconSearch size={22}/>
                    <span>Search</span>
                </button>
                {!isDirect && (
                    <button type="button" className="tgw-info-action" onClick={() => actions.openModal('addMembers', {channelId: channel.id})} title="Add members">
                        <IconUsers size={22}/>
                        <span>Invite</span>
                    </button>
                )}
                {isChannel && (
                    <button type="button" className="tgw-info-action" onClick={() => actions.openModal('channelInfo', {channelId: channel.id})} title="Edit group">
                        <IconEdit size={22}/>
                        <span>Edit</span>
                    </button>
                )}
                <button
                    type="button"
                    className="tgw-info-action tgw-info-action-danger"
                    onClick={() => actions.askConfirm({
                        title: isDirect ? `Close conversation with ${summary.title}?` : `Leave ${summary.title}?`,
                        confirmLabel: isDirect ? 'Close' : 'Leave',
                        danger: true,
                        onConfirm: () => api.leaveChannel(channel.id).then(() => actions.toast('Done', 'success')).catch(() => actions.toast('Could not leave the chat', 'error')),
                    })}
                    title="Leave"
                >
                    <IconLogout size={22}/>
                    <span>{isDirect ? 'Close' : 'Leave'}</span>
                </button>
            </div>

            {peers.length > 0 && (
                <div className="tgw-info-block">
                    <div className="tgw-info-block-title">Participant{peers.length > 1 ? 's' : ''}</div>
                    {peers.map((user) => (
                        <div className="tgw-info-row" key={user.id}>
                            <span className="tgw-info-row-label">@{user.username}</span>
                            <span className="tgw-info-row-value">{user.position || ''}</span>
                        </div>
                    ))}
                </div>
            )}

            {channel.purpose && (
                <div className="tgw-info-block">
                    <div className="tgw-info-block-title">Description</div>
                    <div className="tgw-info-text">{channel.purpose}</div>
                </div>
            )}
            {channel.header && (
                <div className="tgw-info-block">
                    <div className="tgw-info-block-title">Header</div>
                    <div className="tgw-info-text">{channel.header}</div>
                </div>
            )}
            {isDirect && peers[0] && (
                <div className="tgw-info-block">
                    <div className="tgw-info-block-title">Details</div>
                    <div className="tgw-info-row"><span className="tgw-info-row-label">Username</span><span className="tgw-info-row-value">@{peers[0].username}</span></div>
                    {peers[0].nickname && <div className="tgw-info-row"><span className="tgw-info-row-label">Nickname</span><span className="tgw-info-row-value">{peers[0].nickname}</span></div>}
                    {peers[0].position && <div className="tgw-info-row"><span className="tgw-info-row-label">Position</span><span className="tgw-info-row-value">{peers[0].position}</span></div>}
                    {peers[0].email && <div className="tgw-info-row"><span className="tgw-info-row-label">Email</span><span className="tgw-info-row-value">{peers[0].email}</span></div>}
                </div>
            )}

            {!isDirect && members.length > 0 && (
                <div className="tgw-info-block">
                    <div className="tgw-info-block-title">{memberCountLabel(Math.max(memberCount, members.length))}</div>
                    <div className="tgw-members">
                        {members.map(({id, user}) => (
                            <button type="button" className="tgw-member" key={id} onContextMenu={(event) => openMemberMenu(event, user)} onClick={() => actions.openModal('newContact', {userId: id})}>
                                <Avatar userId={id} name={displayName(user)} size={40}/>
                                <span className="tgw-member-body">
                                    <span className="tgw-member-name">{displayName(user)}</span>
                                    <span className="tgw-member-username">@{user.username}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {memberMenu && <Menu x={memberMenu.x} y={memberMenu.y} items={memberMenu.items} onClose={() => setMemberMenu(null)}/>}
        </aside>
    );
}
