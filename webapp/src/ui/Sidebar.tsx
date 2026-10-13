// Left column: header (menu + search), folders, chat list and the user panel.

import React, {useEffect, useMemo, useRef, useState} from 'react';
import {api} from '../mm/api';
import {searchEmoji} from '../mm/emoji';
import {
    getChatSummary,
    getContacts,
    getCurrentTeamId,
    getMyId,
    getTabChats,
    getTeams,
    searchChats,
    searchContactCandidates,
} from '../mm/selectors';
import type {ChatSummary} from '../mm/selectors';
import {getStatus, getTeams as teamsSelector, getUser} from '../mm/selectors';
import {getState, useSelector} from '../mm/store';
import type {MMPost} from '../mm/types';
import {displayName, formatChatTime, statusLabel, toPlainPreview, truncate} from '../mm/utils';
import {markChannelUnreadFromLastPost} from '../mm/unread';
import {ChatList} from './ChatList';
import {useTg} from './context';
import {Menu, menuPositionFromElement} from './menu';
import type {MenuEntry} from './menu';
import {Avatar, Badge, IconMenu, IconNewChat, IconSearch, IconSettings} from './primitives';

function SearchResults({term}: {term: string}) {
    const {actions, timeFormat} = useTg();
    const chats = useSelector((state) => searchChats(state, term));
    const contacts = useSelector((state) => searchContactCandidates(state, term, 12));
    const [messageHits, setMessageHits] = useState<{post: MMPost; channelId: string; title: string}[]>([]);
    const teamId = useSelector(getCurrentTeamId);

    useEffect(() => {
        const trimmed = term.trim();
        if (trimmed.length < 3 || !teamId) {
            setMessageHits([]);
            return undefined;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
            api.searchPosts(teamId, trimmed, {perPage: 20})
                .then((data) => {
                    if (cancelled || !data) {
                        return;
                    }
                    const posts: MMPost[] = (data.order || []).map((id) => data.posts[id]).filter(Boolean);
                    setMessageHits(posts.map((post) => ({
                        post,
                        channelId: post.channel_id,
                        title: '',
                    })));
                })
                .catch(() => {
                    if (!cancelled) {
                        setMessageHits([]);
                    }
                });
        }, 350);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [term, teamId]);

    const chatTitle = (channelId: string) => {
        const summary = getChatSummary(getState(), channelId);
        return summary ? summary.title : '';
    };

    const hasAnything = chats.length || contacts.length || messageHits.length;

    return (
        <div className="tgw-search-results">
            {chats.length > 0 && (
                <>
                    <div className="tgw-section-title">Chats</div>
                    <ChatList
                        chats={chats}
                        selectedChannelId=""
                        onSelect={(id) => actions.openChat(id)}
                        prefetchLimit={6}
                    />
                </>
            )}
            {contacts.length > 0 && (
                <>
                    <div className="tgw-section-title">Contacts</div>
                    <div className="tgw-chat-list">
                        {contacts.map((user) => (
                            <button
                                type="button"
                                key={user.id}
                                className="tgw-chat-row"
                                onClick={() => actions.openModal('newContact', {userId: user.id})}
                            >
                                <Avatar userId={user.id} name={displayName(user)} size={54} status={getStatusOf(user.id)} showStatus/>
                                <span className="tgw-chat-row-body">
                                    <span className="tgw-chat-row-top">
                                        <span className="tgw-chat-row-title">{displayName(user)}</span>
                                    </span>
                                    <span className="tgw-chat-row-bottom">
                                        <span className="tgw-chat-row-preview">@{user.username}</span>
                                    </span>
                                </span>
                            </button>
                        ))}
                    </div>
                </>
            )}
            {messageHits.length > 0 && (
                <>
                    <div className="tgw-section-title">Messages</div>
                    <div className="tgw-chat-list">
                        {messageHits.map((hit) => (
                            <button
                                type="button"
                                key={hit.post.id}
                                className="tgw-chat-row tgw-message-hit"
                                onClick={() => actions.openChat(hit.channelId, {postId: hit.post.id})}
                            >
                                <span className="tgw-chat-row-body">
                                    <span className="tgw-chat-row-top">
                                        <span className="tgw-chat-row-title">{chatTitle(hit.channelId) || 'Conversation'}</span>
                                        <span className="tgw-chat-row-time">{formatChatTime(hit.post.create_at, timeFormat)}</span>
                                    </span>
                                    <span className="tgw-chat-row-bottom">
                                        <span className="tgw-chat-row-preview">{truncate(toPlainPreview(hit.post.message), 90)}</span>
                                    </span>
                                </span>
                            </button>
                        ))}
                    </div>
                </>
            )}
            {!hasAnything && <div className="tgw-empty-list"><div className="tgw-empty-title">Nothing found</div></div>}
        </div>
    );
}

function getStatusOf(userId: string): string {
    // small helper to avoid re-rendering the whole list on status changes of unrelated users
    return 'offline';
}

export function Sidebar() {
    const {ui, actions, tabs, timeFormat, settings, me} = useTg();
    const chats = useSelector((state) => getTabChats(state, ui.activeTabId));
    const contacts = useSelector(getContacts);
    const myId = useSelector(getMyId);
    const myStatus = useSelector((state) => getStatus(state, myId));
    const teams = useSelector(teamsSelector);
    const currentTeamId = useSelector(getCurrentTeamId);
    const [menu, setMenu] = useState<{x: number; y: number; items: MenuEntry[]; align?: 'left' | 'right'} | null>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const menuButtonRef = useRef<HTMLButtonElement>(null);
    const newChatButtonRef = useRef<HTMLButtonElement>(null);
    const userButtonRef = useRef<HTMLButtonElement>(null);

    const tab = tabs.find((entry) => entry.id === ui.activeTabId) || tabs[0];
    const isSearching = ui.search.trim().length > 0;

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                searchRef.current?.focus();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);

    const teamItems = useMemo(() => {
        const items: MenuEntry[] = [];
        Object.values(teams).forEach((team) => {
            if (team.delete_at) {
                return;
            }
            items.push({
                key: `team-${team.id}`,
                label: team.display_name,
                checked: team.id === currentTeamId,
                onClick: () => {
                    window.location.assign(`${(window as any).basename || ''}/${team.name}`);
                },
            });
        });
        return items;
    }, [teams, currentTeamId]);

    const openMainMenu = () => {
        const position = menuPositionFromElement(menuButtonRef.current);
        const items: MenuEntry[] = [
            {key: 'new-group', label: 'New Group', icon: <IconNewChat size={18}/>, onClick: () => actions.openModal('newGroup')},
            {key: 'new-channel', label: 'New Group', icon: <IconUsersIcon/>, onClick: () => actions.openModal('newChannel')},
            {key: 'contacts', label: 'Contacts', onClick: () => actions.setTab('__contacts')},
            'separator',
        ];
        if (teamItems.length > 1) {
            items.push({key: 'teams', label: `Team: ${teams[currentTeamId]?.display_name || '-'}`, icon: <IconUsersIcon/>});
            teamItems.forEach((item) => {
                if (item !== 'separator') {
                    items.push({...item, key: `m-${item.key}`});
                }
            });
            items.push('separator');
        }
        items.push(
            {key: 'settings', label: 'Settings', icon: <IconSettings size={18}/>, onClick: () => actions.openModal('settings')},
            {key: 'disable', label: 'Switch to Mattermost UI', onClick: () => actions.disableUI()},
        );
        setMenu({...position, items});
    };

    const openNewChatMenu = () => {
        const position = menuPositionFromElement(newChatButtonRef.current, 'right');
        setMenu({
            ...position,
            align: 'right',
            items: [
                {key: 'chat', label: 'New Message', onClick: () => actions.openModal('newContact')},
                {key: 'group', label: 'New Group', onClick: () => actions.openModal('newGroup')},
                {key: 'channel', label: 'New Group', onClick: () => actions.openModal('newChannel')},
            ],
        });
    };

    const openUserMenu = () => {
        const position = menuPositionFromElement(userButtonRef.current);
        const statuses: Array<{key: string; label: string}> = [
            {key: 'online', label: 'Online'},
            {key: 'away', label: 'Away'},
            {key: 'dnd', label: 'Do not disturb'},
            {key: 'offline', label: 'Invisible'},
        ];
        setMenu({
            ...position,
            items: [
                ...statuses.map((status) => ({
                    key: `status-${status.key}`,
                    label: status.label,
                    checked: myStatus === status.key,
                    onClick: () => {
                        api.updateUserStatus(myId, status.key).catch(() => actions.toast('Could not update your status', 'error'));
                    },
                })),
                'separator' as const,
                {key: 'settings', label: 'Settings', icon: <IconSettings size={18}/>, onClick: () => actions.openModal('settings')},
            ],
        });
    };

    const contextMenuForChat = (event: React.MouseEvent, summary: ChatSummary) => {
        event.preventDefault();
        const items: MenuEntry[] = [
            {key: 'open', label: 'Open chat', onClick: () => actions.openChat(summary.id)},
            {
                key: 'read',
                label: 'Mark as read',
                onClick: () => {
                    api.viewChannel(summary.id).catch(() => undefined);
                },
            },
            {
                key: 'unread',
                label: 'Mark as unread',
                disabled: !summary.lastPostAt,
                onClick: () => {
                    markChannelUnreadFromLastPost(summary.id)
                        .then((ok) => {
                            if (!ok) {
                                actions.toast('Could not mark as unread', 'error');
                            }
                        })
                        .catch(() => actions.toast('Could not mark as unread', 'error'));
                },
            },
            {
                key: 'favorite',
                label: summary.isFavorite ? 'Remove from favorites' : 'Add to favorites',
                onClick: () => {
                    const plugin = (window as any).WebappUtils;
                    if (plugin?.channels?.favoriteChannel) {
                        if (summary.isFavorite) {
                            plugin.channels.unfavoriteChannel(summary.id);
                        } else {
                            plugin.channels.favoriteChannel(summary.id);
                        }
                    }
                },
            },
            {
                key: 'mute',
                label: summary.muted ? 'Unmute' : 'Mute',
                onClick: () => {
                    api.updateChannelNotifyProps(summary.id, myId, {
                        desktop: summary.muted ? 'default' : 'none',
                        mark_unread: summary.muted ? 'all' : 'mention',
                    }).catch(() => actions.toast('Could not change notifications', 'error'));
                },
            },
            'separator',
            {
                key: 'leave',
                label: summary.type === 'D' ? 'Close conversation' : 'Leave group',
                danger: true,
                onClick: () => {
                    actions.askConfirm({
                        title: summary.type === 'D' ? `Close conversation with ${summary.title}?` : `Leave ${summary.title}?`,
                        body: summary.type === 'D' ? 'The conversation will be removed from your chat list.' : 'You will need to be re-invited to join again.',
                        confirmLabel: summary.type === 'D' ? 'Close' : 'Leave',
                        danger: true,
                        onConfirm: () => {
                            api.leaveChannel(summary.id).catch(() => actions.toast('Could not leave the chat', 'error'));
                        },
                    });
                },
            },
        ];
        setMenu({x: event.clientX, y: event.clientY, items});
    };

    return (
        <aside className="tgw-sidebar">
            <header className="tgw-sidebar-header">
                <button type="button" className="tgw-icon-button tgw-menu-button" ref={menuButtonRef} onClick={openMainMenu} title="Menu">
                    <IconMenu size={24}/>
                </button>
                <div className="tgw-search">
                    <IconSearch size={20} className="tgw-search-icon"/>
                    <input
                        ref={searchRef}
                        value={ui.search}
                        onChange={(event) => actions.setUI({search: event.target.value})}
                        placeholder="Search"
                        spellCheck={false}
                    />
                    {isSearching && (
                        <button type="button" className="tgw-search-clear" onClick={() => actions.setUI({search: ''})} title="Clear">
                            ×
                        </button>
                    )}
                </div>
                <button type="button" className="tgw-icon-button" ref={newChatButtonRef} onClick={openNewChatMenu} title="New chat">
                    <IconNewChat size={24}/>
                </button>
            </header>

            {!isSearching && settings.folderTabs && tabs.length > 1 && (
                <nav className="tgw-folders">
                    {tabs.map((entry) => (
                        <button
                            type="button"
                            key={entry.id}
                            className={`tgw-folder ${entry.id === ui.activeTabId ? 'tgw-folder-active' : ''}`}
                            onClick={() => actions.setTab(entry.id)}
                        >
                            {entry.label}
                        </button>
                    ))}
                </nav>
            )}

            <div className="tgw-sidebar-body">
                {isSearching ? (
                    <SearchResults term={ui.search}/>
                ) : tab?.kind === 'contacts' ? (
                    <>
                        <div className="tgw-section-title">Contacts — {contacts.length}</div>
                        <div className="tgw-chat-list">
                            {contacts.map((user) => (
                                <button
                                    type="button"
                                    key={user.id}
                                    className="tgw-chat-row"
                                    onClick={() => actions.openModal('newContact', {userId: user.id})}
                                >
                                    <Avatar userId={user.id} name={displayName(user)} size={54}/>
                                    <span className="tgw-chat-row-body">
                                        <span className="tgw-chat-row-top">
                                            <span className="tgw-chat-row-title">{displayName(user)}</span>
                                        </span>
                                        <span className="tgw-chat-row-bottom">
                                            <span className="tgw-chat-row-preview">{user.position || `@${user.username}`}</span>
                                        </span>
                                    </span>
                                </button>
                            ))}
                        </div>
                    </>
                ) : (
                    <ChatList
                        chats={chats}
                        selectedChannelId={ui.selectedChannelId}
                        onSelect={(id) => actions.openChat(id)}
                        onContextMenu={contextMenuForChat}
                        showTeamNames={tab?.kind === 'all'}
                        emptyTitle={tab?.kind === 'unread' ? 'No unread chats' : 'No chats here yet'}
                        emptyBody={tab?.kind === 'unread' ? 'You are all caught up.' : 'Start a conversation to see it listed here.'}
                    />
                )}
            </div>

            <footer className="tgw-user-panel">
                <button type="button" className="tgw-user-button" ref={userButtonRef} onClick={openUserMenu}>
                    <Avatar userId={myId} name={me ? displayName(me) : ''} size={40} status={myStatus} showStatus/>
                    <span className="tgw-user-panel-info">
                        <span className="tgw-user-panel-name">{me ? displayName(me) : 'Me'}</span>
                        <span className="tgw-user-panel-status">{statusLabel(myStatus, 0, timeFormat)}</span>
                    </span>
                    <IconSettings size={20} className="tgw-user-panel-gear"/>
                </button>
            </footer>

            {menu && <Menu x={menu.x} y={menu.y} items={menu.items} align={menu.align} onClose={() => setMenu(null)}/>}
        </aside>
    );
}

function IconUsersIcon() {
    return <IconUsersSmall/>;
}

function IconUsersSmall() {
    return (
        <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3Zm0 2c-2.7 0-6 1.3-6 3.5V19h8v-2.5c0-.9.5-1.9 1.4-2.7A12 12 0 0 0 8 13Zm8 0c-3 0-6 1.5-6 3.5V19h12v-2.5c0-2-3-3.5-6-3.5Z"/>
        </svg>
    );
}
